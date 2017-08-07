// This file provides the external API for launching and talking to the sandboxed iframe.
// The internal API is in sframe-channel.js
define([
    '/common/requireconfig.js'
], function (RequireConfig) {
    var iframe;
    var handlers = {};
    var queries = {};
    var module = { exports: {} };

    var mkTxid = function () {
        return Math.random().toString(16).replace('0.', '') + Math.random().toString(16).replace('0.', '');
    };

    module.exports.init = function (frame, cb) {
        if (iframe) { throw new Error('already initialized'); }
        var txid = mkTxid();
        var intr = setInterval(function () {
            frame.contentWindow.postMessage(JSON.stringify({
                txid: txid,
                content: { requireConf: RequireConfig },
                q: 'INIT'
            }), '*');
        });
        window.addEventListener('message', function (msg) {
            var data = JSON.parse(msg.data);
            if (!iframe) {
                if (data.txid !== txid) { return; }
                clearInterval(intr);
                iframe = frame;
                cb();
            } else if (typeof(data.q) === 'string' && handlers[data.q]) {
                handlers[data.q](data, msg);
            } else if (typeof(data.q) === 'undefined' && queries[data.txid]) {
                queries[data.txid](data, msg);
            } else {
                console.log("Unhandled message");
                console.log(msg);
            }
        });
    };

    module.exports.query = function (q, content, cb) {
        if (!iframe) { throw new Error('not yet initialized'); }
        var txid = mkTxid();
        var timeout = setTimeout(function () {
            delete queries[txid];
            cb("Timeout making query " + q);
        });
        queries[txid] = function (data, msg) {
            clearTimeout(timeout);
            delete queries[txid];
            cb(undefined, data.content, msg);
        };
        iframe.contentWindow.postMessage(JSON.stringify({
            txid: txid,
            content: content,
            q: q
        }), '*');
    };

    module.exports.registerHandler = function (queryType, handler) {
        if (typeof(handlers[queryType]) !== 'undefined') { throw new Error('already registered'); }
        handlers[queryType] = function (msg) {
            var data = JSON.parse(msg.data);
            handler(data.content, function (replyContent) {
                msg.source.postMessage(JSON.stringify({
                    txid: data.txid,
                    content: replyContent
                }), '*');
            }, msg);
        };
    };

    return module.exports;
});
