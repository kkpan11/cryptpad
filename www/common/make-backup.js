// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

define([
    'jquery',
    '/file/file-crypto.js',
    '/common/common-hash.js',
    '/common/common-util.js',
    '/common/common-interface.js',
    '/common/hyperscript.js',
    '/common/common-feedback.js',
    '/common/user-object.js',
    '/common/inner/cache.js',
    '/customize/messages.js',
    '/components/nthen/index.js',
    '/components/saferphore/index.js',
    '/components/jszip/dist/jszip.min.js',
], function ($, FileCrypto, Hash, Util, UI, h, Feedback, UO,
             Cache, Messages, nThen, Saferphore, JsZip) {
    var saveAs = window.saveAs;

    var sanitize = function (str) {
        return str.replace(/[\\/?%*:|"<>]/gi, '_')/*.toLowerCase()*/;
    };

    var getUnique = function (name, ext, existing) {
        var n = name + ext;
        var i = 1;
        while (existing.indexOf(n.toLowerCase()) !== -1) {
            n = name + ' ('+ i++ + ')' + ext;
        }
        return n;
    };

    var transform = function (ctx, type, sjson, cb, padData) {
        var result = {
            data: sjson,
            ext: '.json',
        };
        var json;
        try {
            json = JSON.parse(sjson);
        } catch (e) {
            return void cb(result);
        }
        var path = '/' + type + '/export.js';
        require([path], function (Exporter) {
            Exporter.main(json, function (data, _ext) {
                result.ext = _ext || Exporter.ext || '';
                result.data = data;
                cb(result);
            }, null, ctx.sframeChan, padData);
        }, function () {
            cb(result);
        });
    };


    var _downloadFile = function (ctx, fData, cb, updateProgress) {
        var cancelled = false;
        var href = (fData.href && fData.href.indexOf('#') !== -1) ? fData.href : fData.roHref;
        var parsed = Hash.parsePadUrl(href);
        var hash = parsed.hash;
        var name = fData.filename || fData.title;
        var secret = Hash.getSecrets('file', hash, fData.password);
        var src = (ctx.fileHost || '') + Hash.getBlobPathFromHex(secret.channel);
        var key = secret.keys && secret.keys.cryptKey;

        var fetchObj, decryptObj;

        fetchObj = Util.fetch(src, function (err, u8) {
            if (cancelled) { return; }
            if (err) { return void cb('E404'); }
            decryptObj = FileCrypto.decrypt(u8, key, function (err, res) {
                if (cancelled) { return; }
                if (err) { return void cb(err); }
                if (!res.content) { return void cb('EEMPTY'); }
                var dl = function () {
                    saveAs(res.content, name || res.metadata.name);
                };
                cb(null, {
                    metadata: res.metadata,
                    content: res.content,
                    download: dl
                });
            }, function (data) {
                if (cancelled) { return; }
                if (updateProgress && updateProgress.progress2) {
                    updateProgress.progress2(data);
                }
            });
        }, function (data) {
            if (cancelled) { return; }
            if (updateProgress && updateProgress.progress) {
                updateProgress.progress(data);
            }
        }, ctx.cache);

        var cancel = function () {
            cancelled = true;
            if (fetchObj && fetchObj.cancel) { fetchObj.cancel(); }
            if (decryptObj && decryptObj.cancel) { decryptObj.cancel(); }
        };

        return {
            cancel: cancel
        };

    };


    var _downloadPad = function (ctx, pData, cb, updateProgress) {
        var cancelled = false;
        var cancel = function () {
            cancelled = true;
        };

        var href = (pData.href && pData.href.indexOf('#') !== -1) ? pData.href : pData.roHref;
        var parsed = Hash.parsePadUrl(href);
        var name = pData.filename || pData.title;
        var opts = {
            password: pData.password
        };
        var padData = {
            hash: parsed.hash,
            password: pData.password
        };
        var handler = ctx.sframeChan.on("EV_CRYPTGET_PROGRESS", function (data) {
            if (data.hash !== parsed.hash) { return; }
            updateProgress.progress(data.progress);
            if (data.progress === 1) {
                handler.stop();
                updateProgress.progress2(2);
            }
        });
        ctx.get({
            hash: parsed.hash,
            opts: opts
        }, function (err, val) {
            if (cancelled) { return; }
            if (err) { return; }
            if (!val) { return; }
            transform(ctx, parsed.type, val, function (res) {
                if (cancelled) { return; }
                if (!res.data) { return; }
                var dl = function () {
                    saveAs(res.data, Util.fixFileName(name)+(res.ext || ''));
                };
                updateProgress.progress2(1);
                cb(null, {
                    metadata: res.metadata,
                    content: res.data,
                    download: dl
                });
            }, padData);
        });
        return {
            cancel: cancel
        };

    };

    // Add a file to the zip. We have to cryptget&transform it if it's a pad
    // or fetch&decrypt it if it's a file.
    var addFile = function (ctx, zip, fData, existingNames) {
        if (!fData.href && !fData.roHref) {
            return void ctx.errors.push({
                error: 'EINVAL',
                data: fData
            });
        }

        var href;
        var parsed;
        if (!fData.channel) {
            href = fData.href;
            parsed = {};
            parsed['hashData'] = {type: 'link'};
        } else {
            href = UO.getHref(fData, ctx.currentCryptor);
            parsed = Hash.parsePadUrl(href);
        }
        if (['pad', 'file', 'link'].indexOf(parsed.hashData.type) === -1) { return; }

        // waitFor is used to make sure all the pads and files are process before downloading the zip.
        var w = ctx.waitFor();

        ctx.max++;
        // Work with only 10 pad/files at a time
        ctx.sem.take(function (give) {
            var g = give();
            if (ctx.stop) { return; }

            var to;

            var done = function () {
                if (ctx.stop) { return; }
                if (to) { clearTimeout(to); }
                //setTimeout(g, 2000);
                ctx.done++;
                ctx.updateProgress('download', {max: ctx.max, current: ctx.done});
                g();
                w();
            };

            var error = function (err) {
                if (ctx.stop) { return; }
                done();
                return void ctx.errors.push({
                    error: err,
                    data: fData
                });
            };

            var timeout = 60000;
            // OO pads can only be converted one at a time so we have to give them a
            // bigger timeout value in case there are 5 of them in the current queue
            if (['sheet', 'doc', 'presentation'].indexOf(parsed.type) !== -1) {
                timeout = 180000;
            }

            to = setTimeout(function () {
                error('TIMEOUT');
            }, timeout);

            setTimeout(function () {
                if (ctx.stop) { return; }
                var opts = {
                    password: fData.password
                };
                var rawName = fData.filename || fData.title || fData.name || 'File';
                console.log(rawName);

                // Pads (pad,code,slide,kanban,poll,...)
                var todoPad = function () {
                    ctx.get({
                        hash: parsed.hash,
                        opts: opts
                    }, function (err, val) {
                        if (ctx.stop) { return; }
                        if (err) { return void error(err); }
                        if (!val) { return void error('EEMPTY'); }

                        var opts = {
                            binary: true,
                        };
                        transform(ctx, parsed.type, val, function (res) {
                            if (ctx.stop) { return; }
                            if (!res.data) { return void error('EEMPTY'); }
                            var fileName = getUnique(sanitize(rawName), res.ext, existingNames);
                            existingNames.push(fileName.toLowerCase());
                            zip.file(fileName, res.data, opts);
                            console.log('DONE ---- ' + fileName);
                            setTimeout(done, 500);
                        }, {
                            hash: parsed.hash,
                            password: fData.password
                        });
                    });
                };

                // Files (mediatags...)
                var todoFile = function () {
                    var it;
                    var dl = _downloadFile(ctx, fData, function (err, res) {
                        if (it) { clearInterval(it); }
                        if (err) { return void error(err); }
                        var opts = {
                            binary: true,
                        };
                        var extIdx = rawName.lastIndexOf('.');
                        var name = extIdx !== -1 ? rawName.slice(0,extIdx) : rawName;
                        var ext = extIdx !== -1 ? rawName.slice(extIdx) : "";
                        var fileName = getUnique(sanitize(name), ext, existingNames);
                        existingNames.push(fileName.toLowerCase());
                        zip.file(fileName, res.content, opts);
                        console.log('DONE ---- ' + fileName);
                        setTimeout(done, 1000);
                    });
                    it = setInterval(function () {
                        if (ctx.stop) {
                            clearInterval(it);
                            dl.cancel();
                        }
                    }, 50);
                };
                var todoLink = function () {
                    var opts = {
                        binary: true,
                    };
                    var fileName = getUnique(sanitize(rawName), '.txt', existingNames);
                    existingNames.push(fileName.toLowerCase());
                    var content = new Blob([fData.href, '\n'], { type: "text/plain;charset=utf-8" });
                    zip.file(fileName, content, opts);
                    console.log('DONE ---- ' + fileName);
                    setTimeout(done, 1000);
                };
                if (parsed.hashData.type === 'file') {
                    return void todoFile();
                } else if (parsed.hashData.type === 'link') {
                    return void todoLink();
                }
                todoPad();
            });
        });
        // cb(err, blob);
    };

    // Add folders and their content recursively in the zip
    var makeFolder = function (ctx, root, zip, fd, sd) {
        if (typeof (root) !== "object") { return; }
        var existingNames = [];
        Object.keys(root).forEach(function (k) {
            var el = root[k];
            if (typeof el === "object" && el.metadata !== true) { // if folder
                var fName = getUnique(sanitize(k), '', existingNames);
                existingNames.push(fName.toLowerCase());
                ctx.currentCryptor = undefined;
                return void makeFolder(ctx, el, zip.folder(fName), fd, sd);
            }
            if (ctx.data.sharedFolders[el]) { // if shared folder
                let obj = ctx.data.sharedFolders[el];
                let parsed = Hash.parsePadUrl(obj.href || obj.roHref);
                var secret = Hash.getSecrets('drive', parsed.hash, obj.password);
                let cryptor = secret.keys?.secondaryKey ? UO.createCryptor(secret.keys?.secondaryKey)
                                                        : undefined;
                ctx.currentCryptor = cryptor;
                var sfData = ctx.sf[el].metadata;
                var sfName = getUnique(sanitize((sfData && sfData.title) || 'Folder'), '', existingNames);
                existingNames.push(sfName.toLowerCase());
                let staticData = ctx.sf[el].static;
                return void makeFolder(ctx, ctx.sf[el].root, zip.folder(sfName), ctx.sf[el].filesData, staticData);
            }
            var fData = fd[el] || (sd && sd[el]);
            if (fData) {
                addFile(ctx, zip, fData, existingNames);
                return;
            }
        });
    };

    // Main function. Create the empty zip and fill it starting from drive.root
    var create = function (data, getPad, fileHost, cb, progress, cache, sframeChan) {
        if (!data || !data.uo || !data.uo.drive) { return void cb('EEMPTY'); }
        var sem = Saferphore.create(5);
        var ctx = {
            fileHost: fileHost,
            get: getPad,
            data: data.uo.drive,
            folder: data.folder,
            sf: data.sf,
            zip: new JsZip(),
            errors: [],
            sem: sem,
            updateProgress: progress,
            max: 0,
            done: 0,
            cache: cache,
            sframeChan: sframeChan,
            common: data.common,
        };
        var filesData = data.sharedFolderId && ctx.sf[data.sharedFolderId] ? ctx.sf[data.sharedFolderId].filesData : ctx.data.filesData;
        var links = ctx.sf[data.sharedFolderId] && ctx.sf[data.sharedFolderId].static ? ctx.data.static && ctx.sf[data.sharedFolderId].static : ctx.data.static;

        if (ctx.common && !ctx.common.isLoggedIn()) {
            // Anonymous Drive
            ctx.data.root = {};
            let index = 0;
            Object.keys(ctx.data.filesData).forEach(file => {
                ctx.data.root[index] = file;
                index += 1;
            });
        }

        progress('reading', -1); // Msg.settings_export_reading
        nThen(function (waitFor) {
            ctx.waitFor = waitFor;
            var zipRoot = ctx.zip.folder(data.name || Messages.fm_rootName);
            makeFolder(ctx, ctx.folder || ctx.data.root, zipRoot, filesData, links);
            progress('download', {}); // Msg.settings_export_download
        }).nThen(function () {
            console.log(ctx.zip);
            console.log(ctx.errors);
            progress('compressing', -1); // Msg.settings_export_compressing
            ctx.zip.generateAsync({type: 'blob'}).then(function (content) {
                progress('done', -1); // Msg.settings_export_done
                cb(content, ctx.errors);
            });
        });

        var stop = function () {
            ctx.stop = true;
            delete ctx.zip;
        };
        return {
            stop: stop,
            cancel: stop
        };
    };


    var _downloadFolder = function (ctx, data, cb, updateProgress) {
        return create(data, ctx.get, ctx.fileHost, function (blob, errors) {
            if (errors && errors.length) { console.error(errors); } // TODO show user errors
            var dl = function () {
                saveAs(blob, data.folderName);
            };
            cb(null, {download: dl});
        }, function (state, progress) {
            if (state === "reading") {
                updateProgress.folderProgress(0);
            }
            if (state === "download") {
                if (typeof progress.current !== "number") { return; }
                updateProgress.folderProgress(progress.current / progress.max);
            }
            else if (state === "compressing") {
                updateProgress.folderProgress(2);
            }
            else if (state === "done") {
                updateProgress.folderProgress(3);
            }
        }, ctx.cache, ctx.sframeChan);
    };

    var createExportUI = function (origin) {
        var progress = h('div.cp-export-progress');
        var actions = h('div.cp-export-actions');
        var errors = h('div.cp-export-errors', [
            h('p', Messages.settings_exportErrorDescription)
        ]);
        var exportUI = h('div#cp-export-container', [
            h('div.cp-export-block', [
                h('h3', Messages.settings_exportTitle),
                h('p', [
                    Messages.settings_exportDescription,
                    h('br'),
                    Messages.settings_exportFailed,
                    h('br'),
                    h('strong', Messages.settings_exportWarning),
                ]),
                progress,
                actions,
                errors
            ])
        ]);
        $('body').append(exportUI);
        $('#cp-sidebarlayout-container').hide();

        var close = function() {
            $(exportUI).remove();
            $('#cp-sidebarlayout-container').show();
        };

        var _onCancel = [];
        var onCancel = function(h) {
            if (typeof(h) !== "function") { return; }
            _onCancel.push(h);
        };
        var cancel = h('button.btn.btn-default', Messages.cancel);
        $(cancel).click(function() {
            UI.confirm(Messages.settings_exportCancel, function(yes) {
                if (!yes) { return; }
                Feedback.send('FULL_DRIVE_EXPORT_CANCEL');
                _onCancel.forEach(function(h) { h(); });
            });
        }).appendTo(actions);

        var error = h('button.btn.btn-danger', Messages.settings_exportError);
        var translateErrors = function(err) {
            if (err === 'EEMPTY') {
                return Messages.settings_exportErrorEmpty;
            }
            if (['E404', 'EEXPIRED', 'EDELETED'].indexOf(err) !== -1) {
                return Messages.settings_exportErrorMissing;
            }
            return Messages._getKey('settings_exportErrorOther', [err]);
        };
        var addErrors = function(errs) {
            if (!errs.length) { return; }
            var onClick = function() {
                console.error('clicked?');
                $(errors).toggle();
            };
            $(error).click(onClick).appendTo(actions);
            var list = h('div.cp-export-errors-list');
            $(list).appendTo(errors);
            errs.forEach(function(err) {
                if (!err.data) { return; }
                var href = (err.data.href && err.data.href.indexOf('#') !== -1) ? err.data.href : err.data.roHref;
                $(h('div', [
                    h('div.title', err.data.filename || err.data.title),
                    h('div.link', [
                        h('a', {
                            href: href,
                            target: '_blank'
                        }, origin + href)
                    ]),
                    h('div.reason', translateErrors(err.error))
                ])).appendTo(list);
            });
        };

        var download = h('button.btn.btn-primary', Messages.download_mt_button);
        var completed = false;
        var complete = function(h, err) {
            if (completed) { return; }
            completed = true;
            $(progress).find('.fa-square-o').removeClass('fa-square-o')
                .addClass('fa-check-square-o');
            $(cancel).text(Messages.filePicker_close).off('click').click(function() {
                _onCancel.forEach(function(h) { h(); });
            });
            $(download).click(h).appendTo(actions);
            addErrors(err);
        };

        var done = {};
        var update = function(step, state) {
            console.log(step, state);
            console.log(done[step]);
            if (done[step] && done[step] === -1) { return; }


            // New step
            if (!done[step]) {
                $(progress).find('.fa-square-o').removeClass('fa-square-o')
                    .addClass('fa-check-square-o');
                $(progress).append(h('p', [
                    h('span.fa.fa-square-o'),
                    h('span.text', Messages['settings_export_' + step] || step)
                ]));
                done[step] = state; // -1 if no bar, object otherwise
                if (state !== -1) {
                    var bar = h('div.cp-export-progress-bar');
                    $(progress).append(h('div.cp-export-progress-bar-container', [
                        bar
                    ]));
                    done[step] = { bar: bar };
                }
                return;
            }

            // Updating existing step
            if (typeof state !== "object") { return; }
            var b = done[step].bar;
            var w = (state.current / state.max) * 100;
            $(b).css('width', w + '%');
            if (!done[step].text) {
                done[step].text = h('div.cp-export-progress-text');
                $(done[step].text).appendTo(b);
            }
            $(done[step].text).text(state.current + ' / ' + state.max);
            if (state.current === state.max) { done[step] = -1; }
        };

        return {
            close: close,
            update: update,
            complete: complete,
            onCancel: onCancel
        };
    };


    return {
        create: create,
        createExportUI: createExportUI,
        downloadFile: _downloadFile,
        downloadPad: _downloadPad,
        downloadFolder: _downloadFolder,
    };
});
