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
    try {
        switch (fnname) {
            case 'ping':
                reply({ pluginaction: 'pong', dispatchId: args.dispatchId, agent: process.platform });
                return 'pong';
            case 'install':
                doInstall(args);
                return 'install started';
            case 'wingetInstall':
                doWingetInstall(args);
                return 'winget started';
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
            var tarExe = (process.env.windir || process.env.WINDIR || 'C:\\Windows') + '\\System32\\tar.exe';
            try {
                var tarChild = cp.execFile(tarExe, ['-xf', downloadPath, '-C', extractDir]);
                var tarMax = 10 * 60 * 1000, tarEl = 0;
                var tarPoll = setInterval(function () {
                    tarEl += 1000;
                    if (typeof tarChild.exitCode === 'number') {
                        clearInterval(tarPoll);
                        if (tarChild.exitCode !== 0) { L('tar exit ' + tarChild.exitCode); return done(-1, 'tar exit ' + tarChild.exitCode); }
                        var target = extractDir + pathSep + archiveInstaller.replace(/\//g, pathSep);
                        if (!fs.existsSync(target)) { L('cible non trouvée: ' + target); return done(-1, 'cible introuvable dans le zip'); }
                        runInstaller(target, silentArgs, L, done);
                    } else if (tarEl >= tarMax) {
                        clearInterval(tarPoll);
                        try { tarChild.kill(); } catch (e) {}
                        L('tar timeout'); done(-1, 'tar timeout');
                    }
                }, 1000);
            } catch (e) {
                L('tar spawn error: ' + e); done(-1, e);
            }
        } else {
            runInstaller(downloadPath, silentArgs, L, done);
        }
    });
}

function doWingetInstall(data) {
    // Winget sous SYSTEM : winget.exe n'est pas dans le PATH (c'est un MSIX
    // packagé pour l'utilisateur courant). On résout son chemin réel via le
    // dossier WindowsApps de la machine — le binaire fonctionne en SYSTEM
    // tant qu'on l'appelle par chemin absolu.
    var fs = require('fs');
    var cp = require('child_process');
    var dispatchId = data.dispatchId;
    var packageId = data.packageId;
    var modes = { install:1, uninstall:1, upgrade:1, 'upgrade-all':1 };
    var mode = modes[data.mode] ? data.mode : 'install';
    var log = [];
    function L(m) { log.push(m); dbg(m); }

    function done(exit, err, skipped) {
        reply({
            pluginaction: 'installComplete',
            dispatchId: dispatchId,
            exit: (typeof exit === 'number') ? exit : -1,
            log: log.slice(-30).join('\n'),
            error: err ? String(err) : undefined,
            skipped: !!skipped,
        });
    }

    if (mode !== 'upgrade-all' && !packageId) return done(-1, 'packageId manquant');

    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    var wingetExe = '';
    try {
        var wapps = programFiles + '\\WindowsApps';
        var entries = fs.readdirSync(wapps);
        for (var i = 0; i < entries.length; i++) {
            if (/^Microsoft\.DesktopAppInstaller_/i.test(entries[i])) {
                var candidate = wapps + '\\' + entries[i] + '\\winget.exe';
                if (fs.existsSync(candidate)) { wingetExe = candidate; break; }
            }
        }
    } catch (e) { L('scan WindowsApps: ' + e); }

    if (!wingetExe) { L('winget.exe introuvable'); return done(-1, 'winget non installé (App Installer requis)'); }
    L('winget exe: ' + wingetExe);

    // On enveloppe dans cmd.exe /c pour les mêmes raisons que runInstaller
    // (MeshAgent en service bloque les stdio des process lancés direct).
    var exe = windir + '\\System32\\cmd.exe';
    var verb = (mode === 'uninstall') ? 'uninstall'
             : (mode === 'upgrade' || mode === 'upgrade-all') ? 'upgrade'
             : 'install';
    var cmdLine = '"' + wingetExe + '" ' + verb;
    if (mode === 'upgrade-all') {
        cmdLine += ' --all --include-unknown';
    } else {
        cmdLine += ' --id ' + packageId + ' --exact';
    }
    cmdLine += ' --silent --accept-source-agreements --accept-package-agreements';
    // --scope machine n'est dispo qu'à l'install. upgrade hérite du scope
    // d'origine, uninstall n'en a pas besoin.
    if (mode === 'install') cmdLine += ' --scope machine';
    // --force : skip checks divers (signature, dépendances ignorables).
    // --uninstall-previous : désinstalle d'abord la version en place
    //   (la seule manière de reprendre la main quand un paquet a été posé
    //   hors winget, ex: Chrome via MSI Google).
    if (data.force) {
        cmdLine += ' --force';
        // --uninstall-previous uniquement en upgrade : en install, ça fait
        // bailer winget avec 0x8A15005E si le paquet a été posé hors winget
        // (ex: Chrome via MSI Google) — winget ne sait pas le désinstaller.
        // --force seul suffit à overlay-installer par-dessus.
        if (mode === 'upgrade') cmdLine += ' --uninstall-previous';
    }
    // On capture la sortie winget dans un fichier (et non >nul) pour pouvoir
    // la remonter dans le log côté serveur — sinon impossible de diagnostiquer
    // un échec.
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var logFile = tmpRoot + '\\softctl_winget_' + stamp + '.log';
    // On passe par un .bat temporaire : impossible d'éviter sinon le piège de
    // parsing de cmd.exe /c quand cmdLine commence par " (chemin avec espace)
    // ET contient des caractères spéciaux (>). cmd strippe les guillemets
    // externes et casse le chemin → winget ne démarre pas, exit 1, log vide.
    var batFile = tmpRoot + '\\softctl_winget_' + stamp + '.bat';
    try {
        fs.writeFileSync(batFile, '@echo off\r\n' + cmdLine + ' > "' + logFile + '" 2>&1\r\n');
    } catch (e) {
        L('write bat: ' + e);
        return done(-1, 'écriture script winget impossible');
    }
    var argv = ['/c', batFile];
    L('exec cmd /c ' + cmdLine);
    function readWingetLog() {
        try {
            if (!fs.existsSync(logFile)) return;
            var txt = fs.readFileSync(logFile, 'utf8');
            // Garde les ~600 derniers caractères, en stripant les caractères
            // de contrôle de progression (winget spam des \r et codes ANSI).
            txt = txt.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n');
            txt = txt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(-15).join(' | ');
            if (txt) L('winget: ' + txt);
            try { fs.unlinkSync(logFile); } catch (_) {}
            try { fs.unlinkSync(batFile); } catch (_) {}
        } catch (e) {}
    }
    try {
        var child = cp.execFile(exe, argv);
        var finished = false;
        try {
            child.on('exit', function (code) {
                if (finished) return;
                finished = true;
                readWingetLog();
                L('exit ' + code);
                // winget renvoie parfois 0x8A150011 (déjà installé) ou
                // 0x8A15002B (no applicable upgrade) qu'on mappe en succès.
                // Codes "rien à faire" : on les remonte en 'skipped' (≠ succès)
                // pour que l'UI affiche un état distinct au lieu de mentir avec OK.
                // Codes "rien à faire" → état 'skipped' avec motif lisible.
                // Le motif dépend du verbe : "déjà installé" en install, "déjà
                // à jour" en upgrade, etc. Suggérer --force quand pertinent.
                var isInstall = (mode === 'install');
                var hint = isInstall ? ' — cocher Forcer pour réinstaller' : '';
                if (code === -1978335215 /* 0x8A150011 NO_APPLICABLE_INSTALLER */) {
                    L('déjà installé / aucun installeur applicable');
                    return done(code, isInstall ? 'déjà installé' + hint : 'aucun installeur applicable', true);
                }
                if (code === -1978335189 /* 0x8A15002B NO_APPLICABLE_UPGRADE */)   { L('aucune mise à jour applicable'); return done(code, 'aucune mise à jour applicable', true); }
                if (code === -1978335212 /* 0x8A150014 NO_APPLICABLE_UPDATE_FOUND */) { L('rien à mettre à jour'); return done(code, 'rien à mettre à jour', true); }
                if (code === -1978335138 /* 0x8A15005E UPDATE_NOT_APPLICABLE */)   {
                    L('paquet pas géré par winget');
                    return done(code, isInstall ? 'déjà installé hors winget' + hint : 'paquet installé hors winget — non mis à jour', true);
                }
                if (code === -1978335164 /* 0x8A150044 UPGRADE_VERSION_NOT_NEWER */) { L('déjà à la dernière version'); return done(code, 'déjà à la dernière version', true); }
                done(typeof code === 'number' ? code : -1);
            });
        } catch (e) {}
        if (typeof child.exitCode === 'number' && !finished) {
            finished = true;
            L('exit (immédiat) ' + child.exitCode);
            done(child.exitCode);
            return;
        }
        setTimeout(function () {
            if (finished) return;
            finished = true;
            try { child.kill(); } catch (e) {}
            L('timeout (30 min)');
            done(-1, 'timeout');
        }, 30 * 60 * 1000);
    } catch (e) {
        L('spawn error: ' + e);
        done(-1, e);
    }
}

function runInstaller(target, silentArgs, L, done) {
    var cp = require('child_process');
    var ext = target.toLowerCase().split('.').pop();
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    // Wrapper cmd.exe /c — MeshAgent en service bloque le stdio des process
    // lancés directement. Passer par cmd détache proprement et écrit le code
    // retour qu'on lit ensuite.
    var exe = windir + '\\System32\\cmd.exe';
    var cmdLine;
    if (ext === 'msi') {
        // Force /qn /norestart sauf si l'utilisateur a déjà mis /q...
        var msiArgs;
        if (silentArgs && /^\s*\/q/i.test(silentArgs)) msiArgs = silentArgs;
        else msiArgs = '/qn /norestart';
        cmdLine = 'msiexec.exe /i "' + target + '" ' + msiArgs;
    } else {
        cmdLine = '"' + target + '"' + (silentArgs ? ' ' + silentArgs : '');
    }
    var argv = ['/c', cmdLine + ' >nul 2>nul'];
    L('exec cmd /c ' + cmdLine);
    try {
        var child = cp.execFile(exe, argv);
        var finished = false;
        // Listener exit AVANT toute autre opération — sinon on rate l'event
        // si le process sort instantanément (cas msiexec qui délègue à un
        // service Windows Installer et exit immédiatement).
        try {
            child.on('exit', function (code) {
                if (finished) return;
                finished = true;
                L('exit ' + code);
                done(typeof code === 'number' ? code : -1);
            });
        } catch (e) {}
        // Si déjà exited entre temps (race), on déclenche manuellement.
        if (typeof child.exitCode === 'number' && !finished) {
            finished = true;
            L('exit (immédiat) ' + child.exitCode);
            done(child.exitCode);
            return;
        }
        // Timeout dur de sécurité : 30 min sans exit -> on kill.
        setTimeout(function () {
            if (finished) return;
            finished = true;
            try { child.kill(); } catch (e) {}
            L('timeout (30 min)');
            done(-1, 'timeout');
        }, 30 * 60 * 1000);
    } catch (e) {
        L('spawn error: ' + e);
        done(-1, e);
    }
}

function download(url, dest, cb) {
    // Pattern MeshAgent officiel (cf. agents/meshcore.js > downloadFile) :
    //   - require('http').parseUri pour parser l'URL
    //   - require('https').get(options) avec checkServerIdentity custom
    //   - écoute event 'response', stream.pipe() côté agent
    var done = false;
    function finish(ok, err) { if (done) return; done = true; cb(ok ? null : (err || 'erreur')); }
    var options;
    try { options = require('http').parseUri(url); }
    catch (e) { return finish(false, 'parseUri: ' + e); }
    options.rejectUnauthorized = false;
    options.checkServerIdentity = function () { /* accept self-signed */ };
    dbg('download: GET ' + url);
    try {
        var dl = require('https').get(options);
        dl.on('error', function (e) { dbg('dl error: ' + e); finish(false, 'dl: ' + e); });
        dl.on('response', function (res) {
            dbg('download: response status=' + res.statusCode);
            if (res.statusCode !== 200) { finish(false, 'HTTP ' + res.statusCode); return; }
            var fs = require('fs');
            var ws = fs.createWriteStream(dest, { flags: 'wb' });
            ws.on('finish', function () { dbg('download: ws finish'); finish(true); });
            ws.on('error', function (e) { dbg('ws error: ' + e); finish(false, 'ws: ' + e); });
            res.pipe(ws);
        });
    } catch (e) {
        finish(false, 'https.get: ' + e);
    }
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
