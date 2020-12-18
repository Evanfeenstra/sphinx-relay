"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const models_1 = require("../models");
const socket = require("../utils/socket");
const jsonUtils = require("../utils/json");
const resUtils = require("../utils/res");
const helpers = require("../helpers");
const hub_1 = require("../hub");
const lightning_1 = require("../utils/lightning");
const rp = require("request-promise");
const lightning_2 = require("../utils/lightning");
const ldat_1 = require("../utils/ldat");
const cron_1 = require("cron");
const zbase32 = require("../utils/zbase32");
const schemas = require("./schemas");
const confirmations_1 = require("./confirmations");
const network = require("../network");
const meme = require("../utils/meme");
const short = require("short-uuid");
const constants_1 = require("../constants");
const config_1 = require("../utils/config");
const config = config_1.loadConfig();
/*

TODO line 233: parse that from token itself, dont use getMediaInfo at all

"attachment": sends a message to a chat with a signed receipt for a file, which can be accessed from sphinx-meme server
If the attachment has a price, then the media must be purchased to get the receipt

"purchase" sends sats.
if the amount matches the price, the media owner
will respond ("purchase_accept" or "purchase_deny" type)
with the signed token, which can only be used by the buyer

purchase_accept should update the original attachment message with the terms and receipt
(both Relay and client need to do this) or make new???

purchase_deny returns the sats
*/
exports.sendAttachmentMessage = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    // try {
    //   schemas.attachment.validateSync(req.body)
    // } catch(e) {
    //   return resUtils.failure(res, e.message)
    // }
    const { chat_id, contact_id, muid, text, remote_text, remote_text_map, media_key_map, media_type, amount, file_name, ttl, price, // IF AMOUNT>0 THEN do NOT sign or send receipt
    reply_uuid, } = req.body;
    console.log('[send attachment]', req.body);
    const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
    const chat = yield helpers.findOrCreateChat({
        chat_id,
        owner_id: owner.id,
        recipient_id: contact_id
    });
    let TTL = ttl;
    if (ttl) {
        TTL = parseInt(ttl);
    }
    if (!TTL)
        TTL = 31536000; // default year
    const amt = price || 0;
    // generate media token for self!
    const myMediaToken = yield ldat_1.tokenFromTerms({
        muid, ttl: TTL, host: '',
        pubkey: owner.publicKey,
        meta: Object.assign(Object.assign({}, amt && { amt }), { ttl })
    });
    const date = new Date();
    date.setMilliseconds(0);
    const myMediaKey = (media_key_map && media_key_map[owner.id]) || '';
    const mediaType = media_type || '';
    const remoteMessageContent = remote_text_map ? JSON.stringify(remote_text_map) : remote_text;
    const uuid = short.generate();
    const mm = {
        chatId: chat.id,
        uuid: uuid,
        sender: owner.id,
        type: constants_1.default.message_types.attachment,
        status: constants_1.default.statuses.pending,
        amount: amount || 0,
        messageContent: text || file_name || '',
        remoteMessageContent,
        mediaToken: myMediaToken,
        mediaKey: myMediaKey,
        mediaType: mediaType,
        date,
        createdAt: date,
        updatedAt: date
    };
    if (reply_uuid)
        mm.replyUuid = reply_uuid;
    const message = yield models_1.models.Message.create(mm);
    console.log('saved attachment msg from me', message.id);
    saveMediaKeys(muid, media_key_map, chat.id, message.id, mediaType);
    const mediaTerms = {
        muid, ttl: TTL,
        meta: Object.assign({}, amt && { amt }),
        skipSigning: amt ? true : false // only sign if its free
    };
    const msg = {
        mediaTerms,
        id: message.id,
        uuid: uuid,
        content: remote_text_map || remote_text || text || file_name || '',
        mediaKey: media_key_map,
        mediaType: mediaType,
    };
    if (reply_uuid)
        msg.replyUuid = reply_uuid;
    network.sendMessage({
        chat: chat,
        sender: owner,
        type: constants_1.default.message_types.attachment,
        amount: amount || 0,
        message: msg,
        success: (data) => __awaiter(void 0, void 0, void 0, function* () {
            console.log('attachment sent', { data });
            resUtils.success(res, jsonUtils.messageToJson(message, chat));
        }),
        failure: error => resUtils.failure(res, error.message),
    });
});
function saveMediaKeys(muid, mediaKeyMap, chatId, messageId, mediaType) {
    if (typeof mediaKeyMap !== 'object') {
        console.log('wrong type for mediaKeyMap');
        return;
    }
    var date = new Date();
    date.setMilliseconds(0);
    for (let [contactId, key] of Object.entries(mediaKeyMap)) {
        if (parseInt(contactId) !== 1) {
            const receiverID = parseInt(contactId) || 0; // 0 is for a tribe
            models_1.models.MediaKey.create({
                muid, chatId, key, messageId,
                receiver: receiverID,
                createdAt: date,
                mediaType
            });
        }
    }
}
exports.saveMediaKeys = saveMediaKeys;
exports.purchase = (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { chat_id, contact_id, amount, media_token, } = req.body;
    var date = new Date();
    date.setMilliseconds(0);
    try {
        schemas.purchase.validateSync(req.body);
    }
    catch (e) {
        return resUtils.failure(res, e.message);
    }
    const owner = yield models_1.models.Contact.findOne({ where: { isOwner: true } });
    const chat = yield helpers.findOrCreateChat({
        chat_id,
        owner_id: owner.id,
        recipient_id: contact_id
    });
    const message = yield models_1.models.Message.create({
        chatId: chat.id,
        uuid: short.generate(),
        sender: owner.id,
        type: constants_1.default.message_types.purchase,
        amount: amount || 0,
        mediaToken: media_token,
        date: date,
        createdAt: date,
        updatedAt: date,
        network_type: constants_1.default.network_types.lightning
    });
    const msg = {
        mediaToken: media_token, id: message.id, uuid: message.uuid,
        purchaser: owner.id,
    };
    network.sendMessage({
        chat: Object.assign(Object.assign({}, chat.dataValues), { contactIds: [contact_id] }),
        sender: owner,
        type: constants_1.default.message_types.purchase,
        realSatsContactId: contact_id,
        message: msg,
        amount: amount,
        success: (data) => __awaiter(void 0, void 0, void 0, function* () {
            console.log('purchase sent!');
            resUtils.success(res, jsonUtils.messageToJson(message, chat));
        }),
        failure: error => resUtils.failure(res, error.message),
    });
});
/* RECEIVERS */
exports.receivePurchase = (payload) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('=> received purchase', { payload });
    var date = new Date();
    date.setMilliseconds(0);
    const { owner, sender, chat, amount, mediaToken, msg_uuid, chat_type, skip_payment_processing, purchaser_id, network_type } = yield helpers.parseReceiveParams(payload);
    if (!owner || !sender || !chat) {
        return console.log('=> group chat not found!');
    }
    const message = yield models_1.models.Message.create({
        chatId: chat.id,
        uuid: msg_uuid,
        sender: sender.id,
        type: constants_1.default.message_types.purchase,
        amount: amount || 0,
        mediaToken: mediaToken,
        date: date,
        createdAt: date,
        updatedAt: date,
        network_type
    });
    socket.sendJson({
        type: 'purchase',
        response: jsonUtils.messageToJson(message, chat, sender)
    });
    const isTribe = chat_type === constants_1.default.chat_types.tribe;
    // if sats forwarded from tribe owner, for the >1 time
    // dont need to send back token, because admin already has it
    if (isTribe && skip_payment_processing) {
        return console.log('=> skip payment processing');
    }
    const muid = mediaToken && mediaToken.split('.').length && mediaToken.split('.')[1];
    if (!muid) {
        return console.log('no muid');
    }
    const ogMessage = yield models_1.models.Message.findOne({
        where: { mediaToken }
    });
    if (!ogMessage) {
        return console.log('no original message');
    }
    // find mediaKey for who sent
    const mediaKey = yield models_1.models.MediaKey.findOne({
        where: {
            muid, receiver: isTribe ? 0 : sender.id,
        }
    });
    // console.log('mediaKey found!',mediaKey.dataValues)
    if (!mediaKey)
        return; // this is from another person (admin is forwarding)
    const terms = ldat_1.parseLDAT(mediaToken);
    // get info
    let TTL = terms.meta && terms.meta.ttl;
    let price = terms.meta && terms.meta.amt;
    if (!TTL || !price) {
        const media = yield getMediaInfo(muid);
        console.log("GOT MEDIA", media);
        if (media) {
            TTL = media.ttl && parseInt(media.ttl);
            price = media.price;
        }
        if (!TTL)
            TTL = 31536000;
        if (!price)
            price = 0;
    }
    if (amount < price) { // didnt pay enough
        return network.sendMessage({
            chat: Object.assign(Object.assign({}, chat.dataValues), { contactIds: [sender.id] }),
            sender: owner,
            amount: amount,
            type: constants_1.default.message_types.purchase_deny,
            message: { amount, content: 'Payment Denied', mediaToken },
            success: (data) => __awaiter(void 0, void 0, void 0, function* () {
                console.log('purchase_deny sent');
                const denyMsg = yield models_1.models.Message.create({
                    chatId: chat.id,
                    sender: owner.id,
                    type: constants_1.default.message_types.purchase_deny,
                    mediaToken: mediaToken,
                    date: date, createdAt: date, updatedAt: date
                });
                socket.sendJson({
                    type: 'purchase_deny',
                    response: jsonUtils.messageToJson(denyMsg, chat, sender)
                });
            }),
            failure: error => console.log('=> couldnt send purcahse deny', error),
        });
    }
    const theMediaToken = yield ldat_1.tokenFromTerms({
        muid, ttl: TTL, host: '',
        meta: { amt: amount },
        pubkey: sender.publicKey,
    });
    const msgToSend = {
        mediaToken: theMediaToken,
        mediaKey: mediaKey.key,
        mediaType: ogMessage.mediaType,
    };
    if (purchaser_id)
        msgToSend.purchaser = purchaser_id;
    network.sendMessage({
        chat: Object.assign(Object.assign({}, chat.dataValues), { contactIds: [sender.id] }),
        sender: owner,
        type: constants_1.default.message_types.purchase_accept,
        message: msgToSend,
        success: (data) => __awaiter(void 0, void 0, void 0, function* () {
            console.log('purchase_accept sent!');
            const acceptMsg = yield models_1.models.Message.create({
                chatId: chat.id,
                sender: owner.id,
                type: constants_1.default.message_types.purchase_accept,
                mediaToken: theMediaToken,
                date: date, createdAt: date, updatedAt: date
            });
            socket.sendJson({
                type: 'purchase_accept',
                response: jsonUtils.messageToJson(acceptMsg, chat, sender)
            });
        }),
        failure: error => console.log('=> couldnt send purchase accept', error),
    });
});
exports.receivePurchaseAccept = (payload) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('=> receivePurchaseAccept');
    var date = new Date();
    date.setMilliseconds(0);
    const { owner, sender, chat, mediaToken, mediaKey, mediaType, originalMuid, network_type } = yield helpers.parseReceiveParams(payload);
    if (!owner || !sender || !chat) {
        return console.log('=> no group chat!');
    }
    const termsArray = mediaToken.split('.');
    // const host = termsArray[0]
    const muid = termsArray[1];
    if (!muid) {
        return console.log('wtf no muid');
    }
    // const attachmentMessage = await models.Message.findOne({where:{
    //   mediaToken: {$like: `${host}.${muid}%`}
    // }})
    // if(attachmentMessage){
    //   console.log('=> updated msg!')
    //   attachmentMessage.update({
    //     mediaToken, mediaKey
    //   })
    // }
    const msg = yield models_1.models.Message.create({
        chatId: chat.id,
        sender: sender.id,
        type: constants_1.default.message_types.purchase_accept,
        status: constants_1.default.statuses.received,
        mediaToken,
        mediaKey,
        mediaType,
        originalMuid: originalMuid || '',
        date: date,
        createdAt: date,
        updatedAt: date,
        network_type
    });
    socket.sendJson({
        type: 'purchase_accept',
        response: jsonUtils.messageToJson(msg, chat, sender)
    });
});
exports.receivePurchaseDeny = (payload) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('=> receivePurchaseDeny');
    var date = new Date();
    date.setMilliseconds(0);
    const { owner, sender, chat, amount, mediaToken, network_type } = yield helpers.parseReceiveParams(payload);
    if (!owner || !sender || !chat) {
        return console.log('=> no group chat!');
    }
    const msg = yield models_1.models.Message.create({
        chatId: chat.id,
        sender: sender.id,
        type: constants_1.default.message_types.purchase_deny,
        status: constants_1.default.statuses.received,
        messageContent: 'Purchase has been denied and sats returned to you',
        amount: amount,
        amountMsat: parseFloat(amount) * 1000,
        mediaToken,
        date: date,
        createdAt: date,
        updatedAt: date,
        network_type
    });
    socket.sendJson({
        type: 'purchase_deny',
        response: jsonUtils.messageToJson(msg, chat, sender)
    });
});
exports.receiveAttachment = (payload) => __awaiter(void 0, void 0, void 0, function* () {
    console.log('received attachment');
    var date = new Date();
    date.setMilliseconds(0);
    const { owner, sender, chat, mediaToken, mediaKey, mediaType, content, msg_id, chat_type, sender_alias, msg_uuid, reply_uuid, network_type, sender_photo_url } = yield helpers.parseReceiveParams(payload);
    if (!owner || !sender || !chat) {
        return console.log('=> no group chat!');
    }
    const msg = {
        chatId: chat.id,
        uuid: msg_uuid,
        type: constants_1.default.message_types.attachment,
        sender: sender.id,
        date: date,
        createdAt: date,
        updatedAt: date,
        network_type
    };
    if (content)
        msg.messageContent = content;
    if (mediaToken)
        msg.mediaToken = mediaToken;
    if (mediaKey)
        msg.mediaKey = mediaKey;
    if (mediaType)
        msg.mediaType = mediaType;
    if (reply_uuid)
        msg.replyUuid = reply_uuid;
    const isTribe = chat_type === constants_1.default.chat_types.tribe;
    if (isTribe) {
        msg.senderAlias = sender_alias;
        msg.senderPic = sender_photo_url;
    }
    const message = yield models_1.models.Message.create(msg);
    // console.log('saved attachment', message.dataValues)
    socket.sendJson({
        type: 'attachment',
        response: jsonUtils.messageToJson(message, chat, sender)
    });
    hub_1.sendNotification(chat, msg.senderAlias || sender.alias, 'message');
    confirmations_1.sendConfirmation({ chat, sender: owner, msg_id, receiver: sender });
});
function signer(req, res) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!req.params.challenge)
            return resUtils.failure(res, "no challenge");
        try {
            const sig = yield lightning_1.signBuffer(Buffer.from(req.params.challenge, 'base64'));
            const sigBytes = zbase32.decode(sig);
            const sigBase64 = ldat_1.urlBase64FromBytes(sigBytes);
            resUtils.success(res, {
                sig: sigBase64
            });
        }
        catch (e) {
            resUtils.failure(res, e);
        }
    });
}
exports.signer = signer;
function verifier(msg, sig) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const res = yield lightning_1.verifyMessage(msg, sig);
            return res;
        }
        catch (e) {
            console.log(e);
        }
    });
}
exports.verifier = verifier;
function getMyPubKey() {
    return __awaiter(this, void 0, void 0, function* () {
        return new Promise((resolve, reject) => {
            const lightning = lightning_2.loadLightning();
            var request = {};
            lightning.getInfo(request, function (err, response) {
                if (err)
                    reject(err);
                if (!response.identity_pubkey)
                    reject('no pub key');
                else
                    resolve(response.identity_pubkey);
            });
        });
    });
}
exports.getMyPubKey = getMyPubKey;
function cycleMediaToken() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (process.env.TEST_LDAT)
                ldat_1.testLDAT();
            const mt = yield getMediaToken(null);
            if (mt) {
                console.log('=> [meme] authed!');
                meme.setMediaToken(mt);
            }
            new cron_1.CronJob('1 * * * *', function () {
                getMediaToken(true);
            });
        }
        catch (e) {
            console.log(e.message);
        }
    });
}
exports.cycleMediaToken = cycleMediaToken;
const mediaURL = 'http://' + config.media_host + '/';
function getMediaToken(force) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!force && meme.mediaToken)
            return meme.mediaToken;
        yield helpers.sleep(3000);
        try {
            const res = yield rp.get(mediaURL + 'ask');
            const r = JSON.parse(res);
            if (!(r && r.challenge && r.id)) {
                throw new Error('no challenge');
            }
            const sig = yield lightning_1.signBuffer(Buffer.from(r.challenge, 'base64'));
            if (!sig)
                throw new Error('no signature');
            const pubkey = yield getMyPubKey();
            if (!pubkey) {
                throw new Error('no pub key!');
            }
            const sigBytes = zbase32.decode(sig);
            const sigBase64 = ldat_1.urlBase64FromBytes(sigBytes);
            const bod = yield rp.post(mediaURL + 'verify', {
                form: { id: r.id, sig: sigBase64, pubkey }
            });
            const body = JSON.parse(bod);
            if (!(body && body.token)) {
                throw new Error('no token');
            }
            meme.setMediaToken(body.token);
            return body.token;
        }
        catch (e) {
            throw e;
        }
    });
}
exports.getMediaToken = getMediaToken;
function getMediaInfo(muid) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const token = yield getMediaToken(null);
            const res = yield rp.get(mediaURL + 'mymedia/' + muid, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                json: true
            });
            return res;
        }
        catch (e) {
            return null;
        }
    });
}
exports.getMediaInfo = getMediaInfo;
//# sourceMappingURL=media.js.map