"use strict";

const https = require("https");
const url   = require("url");
const FormData = require("form-data");

class LeanKitBoard {
    constructor (opts) {
        if (!opts.email) throw new Error("Constructor Error: email required");
        if (!opts.pass) throw new Error("Constructor Error: pass required");
        if (!opts.host) throw new Error("Constructor Error: host require");
        if (!opts.boardId) throw new Error("Constructor Error: boardId require");

        this.sessionKey = "ASP.NET_SessionId";
        this.cookies = {};

        this.debug = opts.debug || false;
        this.dryRun = opts.dryRun || false;

        this.useSession = opts.useSession || false;

        this.host = opts.host;
        this.port = 443;

        this.boardId = opts.boardId;

        this.email = opts.email;
        this.pass  = opts.pass;
        this.token = new Buffer(`${this.email}:${this.pass}`).toString("base64");

        // gen auth header
        this.auth = `Basic ${this.token}`

        this.basePath = `/kanban/api`

        this.errMessageHash = {
            401: "401 Authorization required - bad user or pass"
        };

        this._lkCodes = {
            100:  "NoData",
            200:  "DataRetrievalSuccess",
            201:  "DataInsertSuccess",
            202:  "DataUpdateSuccess",
            203:  "DataDeleteSuccess",
            500:  "SystemException",
            501:  "MinorException",
            502:  "UserException",
            503:  "FatalException",
            800:  "ThrottleWaitResponse",
            900:  "WipOverrideCommentRequired",
            902:  "ResendingEmailRequired",
           1000:  "UnauthorizedAccess"
        }
    }

    _doReq (opts, cb) {
        const path = opts.path;
        const method = (opts.data === void 0 && opts.file === void 0) ? opts.method || "GET" : "POST";

        let headers = {
            host: this.host,
            "authorization": this.auth
        }

        if (opts.headers) {
            // computed auth header and host take precedence
            headers = Object.assign({}, opts.headers, headers);
        }

        if (this.useSession) {
            this._setCookie(headers);
        }

        let payload, f;

        if (opts.multi && opts.file) { // do mutlipart-form encoded file POST
            if (!Buffer.isBuffer(opts.file.data)) {
                let err = new Error("LeanKitBoard - opts.data is not a Buffer. It needs to be a Buffer, ok?");
                return cb(err);
            }

            let fileBuf  = opts.file.data;
            let filename = opts.file.filename;
            let desc     = opts.file.description;

            // do multi-part/form encoding
            f = new FormData();

            f.append("file", fileBuf, {
                filename: filename
            })

            f.append("Description", desc || "Uploaded by LeanKitBoard client");

            headers = Object.assign({
                "content-length": f.getLengthSync()
            }, headers, f.getHeaders());

        } else if (opts.data) { // encode as json
            try {
                payload = JSON.stringify(opts.data);
                // TODO do the chunked thing here?
                headers["content-length"] = payload.length;
                headers["content-type"] = "application/json";

            } catch (e) {
                return cb(e);
            }
        }

        const reqOpts = {
            hostname: this.host,
            port: 443,
            path: path,
            method: method,
            headers: headers
        }

        if (this.debug) console.info(reqOpts);

        if (!this.dryRun) {
            let req = https.request(reqOpts);

            req.on("response", onResp.bind(this));
            req.on("error", onErr.bind(this));

            if (payload) {
                req.write(payload);
            } else if (opts.multi) {
                f.pipe(req);
            }

            req.end();

        } else {
            process.exit();
        }

        function onResp (resp) {
            resp.setEncoding("utf8");

            if (this.debug) {
                console.info(`HTTP/${resp.httpVersion} ${resp.statusCode} ${resp.statusMessage}`)
                console.info(resp.headers);
            }

            if (this.useSession) {
                this._parseCookie(resp);
            }

            // http error resp! NOT a leankit api error, mind you
            if (resp.statusCode >= 400) {
                let err = new Error("LeanKit Client Error")

                err._path = path;
                err._statusCode = resp.statusCode;
                err._statusMessage = resp.statusMessage;

                err.message = this.errMessageHash[resp.statusCode] || "Err message tbd";

                return cb(err);

            } else {
                this._resp = "";

                let self = this;

                resp.on("data", chunk => this._doChunk(chunk));
                resp.on("end", chunk => { this._doEnd(resp, cb); });

                resp.on("error", err => cb(err))
            }
        }

        // for tcp, http parse, and other 'this side' errors
        function onErr (err) {
            console.info("### onErr")
            cb(err);
        }
    }

    _setCookie (headers) {
        if (this.cookies[this.sessionKey])
            headers["cookie"] = this.cookies[this.sessionKey]._cookieString;
    }

    _parseCookie(resp) {
        if (resp.headers.hasOwnProperty("set-cookie")) {
            let cookieStrings = resp.headers["set-cookie"];

            cookieStrings.forEach((cookieStr) => {
                let parts = cookieStr.split(";");

                let _cookie = parts[0].split("=");
                let _meta = parts.slice(1);

                let key = _cookie[0];
                let val = _cookie[1];

                let cookie = {
                    sid: key,
                    value: val,
                    _cookieString: parts[0] + ";",
                    path: null,
                    expires: null,
                    secure: null,
                    httponly: null,
                    domain: null,
                    "max-age": null,
                    extension: null,
                    _timestamp: Date.now()
                }

                if (_meta.length > 0) {

                    for (let attr of _meta) {

                        if (/=/.test(attr)) {
                            let attrParts = attr.split("=");
                            let attrKey = attrParts[0].toLowerCase().trim();
                            let attrVal = attrParts[1].trim();

                            if (cookie.hasOwnProperty(attrKey)) {
                                cookie[attrKey] = attrVal;
                            }

                        } else {
                            attr = attr.toLowerCase().trim();

                            if (cookie.hasOwnProperty(attr))
                                cookie[attr] = true;
                        }
                    }
                }

                if (cookie.expires !== null) {
                    cookie["_expires-death"] = new Date(cookie.expires).getTime();
                }

                if (cookie["max-age"] !== null) {
                    cookie["_max-age-death"]
                        = cookie._timestamp + (cookie["max-age"] * 1000);
                }

                this.cookies[key] = cookie;
            })

            if (this.debug) console.info(this.cookies);
        }
    }

    _doChunk (chunk) {
        this._resp += chunk;
    }

    _doEnd (resp, cb) {
        let headers = resp.headers;

        let ct = headers["content-type"];

        // JSON body
        if (ct && /json/.test(ct)) {
            try {
                let data = JSON.parse(this._resp);

                this._sortLeanKitResponse(resp, data, cb);

            } catch (e) {
                return cb(e);

            } finally {
                // will I see this down there in sortlkresp?
                this._resp = "";
            }

        // Every other kind of body
        } else {
            cb(null, this._resp);
            this._resp = "";
        }
    }

    _sortLeanKitResponse (resp, lkResp, cb) {
        let code = lkResp.ReplyCode;
        let msg  = lkResp.ReplyText;
        let data = lkResp.ReplyData;

        // LeanKit error! NOT an HTTP error
        if (code >= 500) {
            let err = new Error("LeanKit API Error");
            // HTTP stuff
            err._statusCode = resp.statusCode;
            err._statusMessage = resp.statusMessage;

            // Weird LK garbage
            err._lkStatusCode = code;
            err._lkStatusMessage = msg;
            err._lkCodeDescription = this._lkCodes[code] || "No description found";

            err._lkRespBody = this._resp;

            return cb(err);

        } else {
            cb(null, data);
        }
    }

    getBoard (cb) {
        let path = `${this.basePath}/boards/${this.boardId}`;

        this._doReq({ path: path }, onGet);

        function onGet (err, resArr) {
            if (err) return cb(err);

            cb(null, resArr[0]);
        }
    }

    getCard (cardId, cb) {
        let path = `${this.basePath}/board/${this.boardId}/getcard/${cardId}`;

        this._doReq({ path: path }, onGetCard);

        function onGetCard (err, resArr) {
            if (err) return cb(err);

            // data from LK always comes back as an array
            // so for things expecting a singular response, we pop the 1 item
            // array
            cb(null, resArr[0]);
        }
    }

    postCard (opts, cb) {
        let card = opts.card;
        let laneId = opts.laneId;
        let position = opts.position || 0;
        let path = `${this.basePath}/board/${this.boardId}/AddCard/lane/${laneId}/position/${position}`;

        this._doReq({ path: path, data: card }, onPost);

        function onPost (err, res) {
            if (err) return cb(err);
            cb(null, res[0]);
        }
    }

    delCard () {}

    postAttachment (cardId, fileObj, cb) {
        let path = `${this.basePath}/card/saveAttachment/${this.boardId}/${cardId}`;

        let options = {
            path: path,
            multi: true,
            file: {
                data: fileObj.data,
                filename: fileObj.filename,
                description: fileObj.description
            }
        };

        this._doReq(options, onPost);

        function onPost (err, res) {
            if (err) return cb(err);
            cb(null, res);
        }
    }

    getAttachmentList (cardId, cb) {
        let path = `${this.basePath}/card/getAttachments/${this.boardId}/${cardId}`;

        this._doReq({ path: path }, onGet);

        function onGet (err, resp) {
            if (err) return cb(err);

            cb(null, resp[0]);
        }
        // https://{accountname}.leankit.com/kanban/api/card/GetAttachments/{boardId}/{cardId}
        // Sample ReplyData, comes in an Array:
        //{
            //"Id": 256819669,
            //"FileName": "Important Document.pdf",
            //"Description": "Description of really important document",
            //"CreatedOn": "10/15/2015 at 11:57:06 AM",
            //"LastModified": "10/15/2015 at 11:57:06 AM",
            //"StorageId": "0e4a503f-40e3-4740-a2fe-b8b32d781361",
            //"AttachmentSize": 213,
            //"CardId": 256817369,
            //"CreatedById": 62984826,
            //"CreatedByFullName": "David Neal",
            //"LastModifiedById": 0,
            //"LastModifiedByFullName": "",
            //"Stream": null,
            //"GravatarLink": "3ab1249be442027903e1180025340b3f"
        //},
    }

    assignUser (cardId, userId, cb) {
        // https://{accountname}.leankit.com/kanban/api/board/{boardId}/AssignUserLite
        //
        // sample payload
        //{
            //"CardId":256395058,
            //"UserId":62984826,
            //"OverrideComment":null
        //}

    }

    unassignUser (cardId, userId) {
        // POST
        // https://{accountname}.leankit.com/kanban/api/board/{boardId}/UnassignUserLite
            //"CardId":256395058,
            //"UserId":62984826,
    }

    getComments (cardId, cb) {
        // TODO strip the html off the content of the comments' Text prop, perhaps
        // optionally

        // NOTE this won't report if LK can't find the card id

        let path = `${this.basePath}/card/getComments/${this.boardId}/${cardId}`;

        this._doReq({ path: path }, onGetComments);

        function onGetComments (err, resArr) {
            if (err) return cb(err);

            // this comes back as an array of an array...
            cb(null, resArr[0]);
        }
    }

    postComment (cardId, comment, cb) {
        //  "Text": "Woo this is a comment"
        let path = `${this.basePath}/card/saveComment/${this.boardId}/${cardId}`;

        let opts = {
            method: "POST",
            data: { Text: comment },
            multiPart: false,
            path: path
        };

        this._doReq(opts, cb);
    }
}

module.exports = LeanKitBoard;
