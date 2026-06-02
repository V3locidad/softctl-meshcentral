/*
 * softctl — agent-side executor (meshcore module).
 *
 * MeshCentral pousse ce module sur chaque agent. Quand le serveur envoie un
 * { action:'plugin', plugin:'softctl', pluginaction:'install', ... }, l'agent
 * appelle consoleaction(args, rights, sessionid, parent) ci-dessous (PAS
 * serveraction — serveraction est côté serveur uniquement).
 *
 * Pour répondre au serveur on utilise parent.SendCommand({...}) qui pousse
 * un message plugin de retour, reçu côté serveur par obj.serveraction.
 */

"use strict";

var mesh = null;

function dbg(m) {
    try {
        var fs = require('fs');
        var s = fs.createWriteStream('softctl.txt', { flags: 'a' });
        s.write('\n' + new Date().toLocaleString() + ': ' + m);
        s.end('\n');
    } catch (e) {}
}

function reply(payload) {
    var msg = { action: 'plugin', plugin: 'softctl' };
    Object.keys(payload).forEach(function (k) { msg[k] = payload[k]; });
    try {
        if (mesh && typeof mesh.SendCommand === 'function') mesh.SendCommand(msg);
        else require('MeshAgent').SendCommand(JSON.stringify(msg));
    } catch (e) { dbg('reply error: ' + e); }
}

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    var fnname = args.pluginaction || (args._ && args._[1]);
    dbg('consoleaction ' + fnname);
    try {
        switch (fnname) {
            case 'ping':
                reply({ pluginaction: 'pong', dispatchId: args.dispatchId, agent: process.platform });
                return 'pong';
            case 'install':
                doInstall(args);
                return 'install started';
            default:
                return 'softctl: action inconnue ' + fnname;
        }
    } catch (e) {
        dbg('consoleaction error: ' + e);
        reply({ pluginaction: 'installComplete', dispatchId: args && args.dispatchId, exit: -1, error: String(e) });
        return 'error ' + e;
    }
}

// Expose consoleaction via module.exports comme les modules meshcore natifs.
// ScriptTask s'en passe (les noms top-level passent), mais on évite tout
// doute sur la résolution de require('softctl').consoleaction.
module.exports = { consoleaction: consoleaction };

function doInstall(data) {
    var fs = require('fs');
    var cp = require('child_process');
    var pathSep = (process.platform === 'win32') ? '\\' : '/';
    var tmpRoot = (process.env.TEMP || process.env.TMP || (process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp'));
    var tmpDir = tmpRoot + pathSep + 'softctl_' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var installer = data.installer || 'installer.exe';
    var silentArgs = data.silentArgs || '';
    var archiveInstaller = data.archiveInstaller || '';
    var dispatchId = data.dispatchId;
    var log = [];
    function L(m) { log.push(m); dbg(m); }

    function done(exit, err) {
        try { rmRf(tmpDir); } catch (e) {}
        reply({
            pluginaction: 'installComplete',
            dispatchId: dispatchId,
            exit: (typeof exit === 'number') ? exit : -1,
            log: log.slice(-30).join('\n'),
            error: err ? String(err) : undefined,
        });
    }

    try { mkdirP(tmpDir); } catch (e) {}
    var downloadPath = tmpDir + pathSep + installer;
    L('download ' + data.url + ' -> ' + downloadPath);

    download(data.url, downloadPath, function (err) {
        if (err) { L('download error: ' + err); return done(-1, err); }
        L('downloaded ok');
        var ext = installer.toLowerCase().split('.').pop();
        if (ext === 'zip') {
            if (!archiveInstaller) { L('zip mais archiveInstaller manquant'); return done(-1, 'archiveInstaller manquant'); }
            var extractDir = tmpDir + pathSep + 'extract';
            try { fs.mkdirSync(extractDir); } catch (e) {}
            L('extract via tar -> ' + extractDir);
            cp.execFile('tar.exe', ['-xf', downloadPath, '-C', extractDir], { timeout: 600000 }, function (xerr) {
                if (xerr) { L('tar error: ' + xerr); return done(-1, 'extract: ' + xerr); }
                var target = extractDir + pathSep + archiveInstaller.replace(/\//g, pathSep);
                if (!fs.existsSync(target)) { L('cible non trouvée: ' + target); return done(-1, 'cible introuvable dans le zip'); }
                runInstaller(target, silentArgs, L, done);
            });
        } else {
            runInstaller(downloadPath, silentArgs, L, done);
        }
    });
}

function runInstaller(target, silentArgs, L, done) {
    var cp = require('child_process');
    var ext = target.toLowerCase().split('.').pop();
    var argv;
    var exe;
    if (ext === 'msi') {
        exe = 'msiexec.exe';
        argv = ['/i', target].concat(silentArgs ? silentArgs.split(/\s+/).filter(Boolean) : []);
        L('msiexec ' + argv.join(' '));
    } else {
        exe = target;
        argv = silentArgs ? silentArgs.split(/\s+/).filter(Boolean) : [];
        L('run ' + target + ' ' + argv.join(' '));
    }
    var child;
    try {
        child = cp.execFile(exe, argv, { timeout: 30 * 60 * 1000 }, function (err, stdout, stderr) {
            var code = child && (child.exitCode != null) ? child.exitCode : (err ? (err.code || -1) : 0);
            if (stdout) L('stdout: ' + String(stdout).slice(-500));
            if (stderr) L('stderr: ' + String(stderr).slice(-500));
            L('exit ' + code);
            done(code);
        });
    } catch (e) {
        L('spawn error: ' + e);
        done(-1, e);
    }
}

function download(url, dest, cb) {
    // Parse manuel — MeshAgent (Duktape) n'a pas le module 'url' de Node.
    var u = parseUrl(url);
    if (!u) return cb('url invalide: ' + url);
    var mod = (u.protocol === 'https:') ? require('https') : require('http');
    var opts = {
        host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.path, method: 'GET', rejectUnauthorized: false,
    };
    var fs = require('fs');
    var done = false;
    var ws = fs.createWriteStream(dest);
    var req = mod.request(opts, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); finish(false, 'redirect non suivi (' + res.statusCode + ')'); return;
        }
        if (res.statusCode !== 200) {
            res.resume(); finish(false, 'HTTP ' + res.statusCode); return;
        }
        res.pipe(ws);
        ws.on('finish', function () { ws.close(function () { finish(true); }); });
        ws.on('error', function (e) { finish(false, String(e)); });
    });
    req.on('error', function (e) { finish(false, String(e)); });
    req.setTimeout(300000, function () { try { req.destroy(); } catch (e) {} finish(false, 'timeout'); });
    req.end();
    function finish(ok, err) { if (done) return; done = true; cb(ok ? null : (err || 'erreur')); }
}

function parseUrl(url) {
    // ex: https://172.17.103.243/softctl-download/abc -> {protocol, hostname, port, path}
    var m = /^(https?:)\/\/([^/:?#]+)(?::(\d+))?(\/.*)?$/i.exec(url);
    if (!m) return null;
    return {
        protocol: m[1].toLowerCase(),
        hostname: m[2],
        port: m[3] ? parseInt(m[3], 10) : null,
        path: m[4] || '/',
    };
}

function mkdirP(p) {
    var fs = require('fs');
    var parts = p.split(/[\\\/]/);
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
        cur += parts[i] + (i === parts.length - 1 ? '' : (process.platform === 'win32' ? '\\' : '/'));
        if (!cur) continue;
        try { fs.mkdirSync(cur); } catch (e) {}
    }
}

function rmRf(p) {
    var fs = require('fs');
    if (!fs.existsSync(p)) return;
    var st = fs.statSync(p);
    if (st.isDirectory()) {
        var entries = fs.readdirSync(p);
        for (var i = 0; i < entries.length; i++) rmRf(p + (process.platform === 'win32' ? '\\' : '/') + entries[i]);
        fs.rmdirSync(p);
    } else {
        try { fs.unlinkSync(p); } catch (e) {}
    }
}
