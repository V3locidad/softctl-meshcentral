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
            case 'wingetInventory':
                doWingetInventory(args);
                return 'inventory started';
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
            log: log.slice(-60).join('\n'),
            error: err ? String(err) : undefined,
            skipped: !!skipped,
        });
    }

    if (mode !== 'upgrade-all' && !packageId) return done(-1, 'packageId manquant');

    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var wingetExe = findWingetExe();

    function continueInstall() {
        L('winget exe: ' + wingetExe);
        runWingetCommand();
    }
    if (!wingetExe) {
        L('winget absent — auto-install en cours');
        installWingetSystem(L, function (instErr) {
            if (instErr) return done(-1, 'auto-install winget échoué : ' + instErr);
            wingetExe = findWingetExe();
            if (!wingetExe) return done(-1, 'winget toujours introuvable après install');
            continueInstall();
        }, data.bundleUrls);
        return;
    }
    continueInstall();
    function runWingetCommand() {

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
        // --source winget : sur certains postes la source msstore est cassée
        // (TLS cert mismatch). Sans ce flag winget bail avec 0x8A15005E
        // « Please specify --source ». On ne vise que la source winget.
        cmdLine += ' --source winget';
    }
    cmdLine += ' --silent --accept-source-agreements --accept-package-agreements --disable-interactivity';
    // --verbose force winget à écrire des lignes diagnostiques sur stdout
    // même en mode silent — sinon on capture un log vide quand il bail tôt.
    cmdLine += ' --verbose';
    // Pas de --scope machine : la plupart des manifests winget (dont
    // Google.Chrome) ne déclarent pas explicitement le scope, et le flag
    // filtre les installeurs jusqu'à 0 match → 0x8A15005E. On tourne en
    // SYSTEM, l'install est machine-wide de fait.
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
    // winget écrit son vrai diag interne dans un fichier dédié via --log,
    // pas sur stdout. Sur une bail précoce (manifest non match, contrainte
    // d'arch, etc.) stdout reste vide mais --log contient tout.
    var wingetLogFile = tmpRoot + '\\softctl_winget_internal_' + stamp + '.log';
    cmdLine += ' --log "' + wingetLogFile + '"';
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
    function toStr(buf) {
        if (typeof buf === 'string') return buf;
        if (!buf) return '';
        try { return buf.toString('utf8'); } catch (_) {}
        try { return String.fromCharCode.apply(null, buf); } catch (_) {}
        return '';
    }
    function readWingetLog() {
        try {
            if (fs.existsSync(logFile)) {
                var txt = toStr(fs.readFileSync(logFile, 'utf8'));
                txt = txt.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n');
                txt = txt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(-15).join(' | ');
                if (txt) L('winget stdout: ' + txt);
                try { fs.unlinkSync(logFile); } catch (_) {}
            }
            if (fs.existsSync(wingetLogFile)) {
                var diag = toStr(fs.readFileSync(wingetLogFile, 'utf8'));
                // Le log winget est riche : on garde les 25 dernières lignes
                // non vides, suffisant pour voir la raison du bail.
                diag = diag.replace(/\r/g, '\n').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(-25);
                for (var i = 0; i < diag.length; i++) L('winget log: ' + diag[i]);
                try { fs.unlinkSync(wingetLogFile); } catch (_) {}
            }
            try { fs.unlinkSync(batFile); } catch (_) {}
        } catch (e) { L('readWingetLog err: ' + e); }
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
                var forced = !!data.force;
                // Hint contextuel : ne pas suggérer "cocher Forcer" si c'est
                // déjà coché — sinon l'utilisateur tourne en rond.
                var hint = (isInstall && !forced) ? ' — cocher Forcer pour réinstaller' : '';
                if (code === -1978335215 /* 0x8A150011 NO_APPLICABLE_INSTALLER */) {
                    L('déjà installé / aucun installeur applicable');
                    return done(code, isInstall ? 'déjà installé' + hint : 'aucun installeur applicable', true);
                }
                if (code === -1978335189 /* 0x8A15002B NO_APPLICABLE_UPGRADE */)   { L('aucune mise à jour applicable'); return done(code, 'aucune mise à jour applicable', true); }
                if (code === -1978335212 /* 0x8A150014 NO_APPLICABLE_UPDATE_FOUND */) { L('rien à mettre à jour'); return done(code, 'rien à mettre à jour', true); }
                if (code === -1978335138 /* 0x8A15005E UPDATE_NOT_APPLICABLE */)   {
                    L('paquet pas géré par winget');
                    var msg;
                    if (isInstall) {
                        msg = forced
                            ? 'déjà installé hors winget — winget refuse de réinstaller par-dessus'
                            : 'déjà installé hors winget' + hint;
                    } else {
                        msg = 'paquet installé hors winget — non mis à jour';
                    }
                    return done(code, msg, true);
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
    } // fin runWingetCommand
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

function findWingetExe() {
    var fs = require('fs');
    var programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    try {
        var wapps = programFiles + '\\WindowsApps';
        var entries = fs.readdirSync(wapps);
        // Récupère toutes les versions présentes, prend la plus récente.
        // Le nom de dossier contient la version, ex :
        //   Microsoft.DesktopAppInstaller_1.20.2402.13_x64__8wekyb3d8bbwe
        var candidates = [];
        for (var i = 0; i < entries.length; i++) {
            var m = entries[i].match(/^Microsoft\.DesktopAppInstaller_([\d.]+)_/i);
            if (!m) continue;
            var c = wapps + '\\' + entries[i] + '\\winget.exe';
            if (fs.existsSync(c)) candidates.push({ path: c, version: m[1] });
        }
        if (!candidates.length) return '';
        candidates.sort(function (a, b) {
            var pa = a.version.split('.').map(function (n) { return parseInt(n, 10) || 0; });
            var pb = b.version.split('.').map(function (n) { return parseInt(n, 10) || 0; });
            for (var k = 0; k < Math.max(pa.length, pb.length); k++) {
                var da = (pb[k] || 0) - (pa[k] || 0);
                if (da !== 0) return da;
            }
            return 0;
        });
        return candidates[0].path;
    } catch (e) {}
    return '';
}

function checkWingetVersion(wingetExe, cb) {
    var cp = require('child_process');
    var fs = require('fs');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var tmpRoot = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var outFile = tmpRoot + '\\softctl_wver_' + stamp + '.txt';
    var batFile = tmpRoot + '\\softctl_wver_' + stamp + '.bat';
    try { fs.writeFileSync(batFile, '@echo off\r\n"' + wingetExe + '" --version > "' + outFile + '" 2>&1\r\n'); }
    catch (e) { return cb(''); }
    try {
        var child = cp.execFile(windir + '\\System32\\cmd.exe', ['/c', batFile]);
        var done2 = false;
        function finish() {
            if (done2) return; done2 = true;
            var out = '';
            try { if (fs.existsSync(outFile)) out = fs.readFileSync(outFile, 'utf8').toString(); } catch (_) {}
            try { fs.unlinkSync(outFile); } catch (_) {}
            try { fs.unlinkSync(batFile); } catch (_) {}
            var m = String(out).match(/v?(\d+\.\d+(?:\.\d+)?)/);
            cb(m ? m[1] : '');
        }
        child.on('exit', finish);
        setTimeout(finish, 8000);
    } catch (e) { cb(''); }
}

function versionLess(a, b) {
    if (!a) return true;
    var pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var da = (pa[i] || 0) - (pb[i] || 0);
        if (da !== 0) return da < 0;
    }
    return false;
}

function installWingetSystem(L, cb, bundleUrls) {
    bundleUrls = bundleUrls || {};
    // Télécharge VCLibs + winget MSIXBundle puis provisionne pour tous les
    // utilisateurs via DISM. Fonctionne en SYSTEM.
    var fs = require('fs');
    var cp = require('child_process');
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var tmpRoot = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e9);
    var workDir = tmpRoot + '\\softctl_winget_install_' + stamp;
    var ps1File = workDir + '\\install.ps1';
    var logFile = workDir + '\\install.log';
    var batFile = workDir + '\\install.bat';
    try { fs.mkdirSync(workDir); } catch (_) {}
    var script = [
        '$ErrorActionPreference = "Stop"',
        '$ProgressPreference = "SilentlyContinue"',
        '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13',
        // Proxy système (IE/WinHTTP) + creds par défaut — sinon les postes
        // derrière un proxy d\'établissement ne peuvent rien télécharger.
        'try {',
        '  $proxy = [System.Net.WebRequest]::GetSystemWebProxy()',
        '  $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials',
        '  [System.Net.WebRequest]::DefaultWebProxy = $proxy',
        '  Write-Output ("proxy: " + $proxy.GetProxy("https://aka.ms").ToString())',
        '} catch { Write-Output ("proxy setup warn: " + $_.Exception.Message) }',
        '$work = "' + workDir.replace(/\\/g, '\\\\') + '"',
        'New-Item -ItemType Directory -Force -Path $work | Out-Null',
        '$vcUrl = ' + (bundleUrls.vclibs ? ('"' + bundleUrls.vclibs + '"') : '"https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx"'),
        '$xamlUrl = ' + (bundleUrls.uixaml ? ('"' + bundleUrls.uixaml + '"') : '"https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.x64.appx"'),
        '$wgUrl = ' + (bundleUrls.winget ? ('"' + bundleUrls.winget + '"') : '"https://aka.ms/getwinget"'),
        // Accepte les certs auto-signés (cas typique d'un MC en interne).
        '[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }',
        '$vcFile = Join-Path $work "vclibs.appx"',
        '$xamlFile = Join-Path $work "uixaml.appx"',
        '$wgFile = Join-Path $work "winget.msixbundle"',
        '$dismLog = Join-Path $work "dism.log"',
        'Write-Output "DL VCLibs"',
        'Invoke-WebRequest -Uri $vcUrl -OutFile $vcFile -UseBasicParsing ',
        'Write-Output "DL UI.Xaml"',
        'try { Invoke-WebRequest -Uri $xamlUrl -OutFile $xamlFile -UseBasicParsing  } catch { Write-Output ("UI.Xaml DL warn: " + $_.Exception.Message); $xamlFile = $null }',
        'Write-Output "DL winget"',
        'Invoke-WebRequest -Uri $wgUrl -OutFile $wgFile -UseBasicParsing ',
        'Write-Output "DISM provision"',
        '$dismExe = Join-Path $env:WINDIR "System32\\dism.exe"',
        '$dismArgs = @("/Online", "/Add-ProvisionedAppxPackage", "/PackagePath:$wgFile", "/DependencyPackagePath:$vcFile", "/SkipLicense", "/LogPath:$dismLog", "/LogLevel:4")',
        'if ($xamlFile -and (Test-Path $xamlFile)) { $dismArgs += "/DependencyPackagePath:$xamlFile" }',
        '& $dismExe @dismArgs 2>&1 | Out-String -Stream | ForEach-Object { Write-Output $_ }',
        'Write-Output "DISM exit: $LASTEXITCODE"',
        'if ($LASTEXITCODE -ne 0) {',
        '  if (Test-Path $dismLog) {',
        '    Write-Output "--- DISM log (dernieres 30 lignes) ---"',
        '    Get-Content $dismLog -Tail 30 | ForEach-Object { Write-Output $_ }',
        '  }',
        '  exit $LASTEXITCODE',
        '}',
        // Initialise les sources pour SYSTEM (les sources sont per-user et
        // sans ça la première commande échoue avec 0x8a15000f).
        'try {',
        '  $wg = Get-ChildItem (Join-Path $env:ProgramFiles "WindowsApps") -Filter "Microsoft.DesktopAppInstaller_*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1',
        '  if ($wg) {',
        '    $wgExe = Join-Path $wg.FullName "winget.exe"',
        '    if (Test-Path $wgExe) {',
        '      & $wgExe source reset --force 2>&1 | Out-Null',
        '      & $wgExe source update --accept-source-agreements 2>&1 | Out-Null',
        '      Write-Output "source reset OK"',
        '    }',
        '  }',
        '} catch { Write-Output ("source reset warn: " + $_.Exception.Message) }',
        'Write-Output "OK"',
    ].join('\r\n');
    try { fs.writeFileSync(ps1File, '﻿' + script); }
    catch (e) { return cb('écriture ps1: ' + e); }
    var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    var line = '"' + psExe + '" -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + ps1File + '" > "' + logFile + '" 2>&1';
    try { fs.writeFileSync(batFile, '@echo off\r\n' + line + '\r\n'); }
    catch (e) { return cb('écriture bat: ' + e); }
    L('install winget : téléchargement + DISM (peut prendre 2-5 min)');
    try {
        var child = cp.execFile(windir + '\\System32\\cmd.exe', ['/c', batFile]);
        var done2 = false;
        function finish(err) {
            if (done2) return; done2 = true;
            var out = '';
            try { if (fs.existsSync(logFile)) out = require('fs').readFileSync(logFile, 'utf8').toString(); } catch (_) {}
            // Cleanup tmp
            try { fs.unlinkSync(ps1File); } catch (_) {}
            try { fs.unlinkSync(logFile); } catch (_) {}
            try { fs.unlinkSync(batFile); } catch (_) {}
            try { fs.rmdirSync(workDir); } catch (_) {}
            var tail = String(out || '').replace(/\r/g, '\n').split('\n').filter(Boolean).slice(-10).join(' | ');
            if (tail) L('winget install log: ' + tail);
            cb(err);
        }
        child.on('exit', function (code) { finish(code === 0 ? null : ('DISM exit ' + code)); });
        setTimeout(function () { try { child.kill(); } catch (_) {} finish('timeout 10 min'); }, 10 * 60 * 1000);
    } catch (e) { cb('spawn: ' + e); }
}

function doWingetInventory(data) {
    var fs = require('fs');
    var cp = require('child_process');
    var dispatchId = data.dispatchId;
    var log = [];
    var lastPing = 0;
    function L(m) {
        log.push(m); dbg(m);
        // Ping périodique vers le serveur pour que l'UI puisse afficher
        // l'avancement (sinon on a juste "Interrogation…" sans signal de vie).
        var now = Date.now();
        if (now - lastPing > 3000) {
            lastPing = now;
            try {
                reply({
                    pluginaction: 'wingetInventoryProgress',
                    dispatchId: dispatchId,
                    line: m,
                    tail: log.slice(-5),
                });
            } catch (_) {}
        }
    }
    function send(payload) {
        var p = { pluginaction: 'wingetInventoryResult', dispatchId: dispatchId };
        Object.keys(payload).forEach(function (k) { p[k] = payload[k]; });
        reply(p);
    }
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';

    var wingetExe = findWingetExe();
    function ensureWingetReady(cb) {
        if (!wingetExe) {
            if (data.autoInstall === false) return cb('winget non installé (App Installer requis)');
            L('winget absent — auto-install');
            return installWingetSystem(L, function (instErr) {
                if (instErr) {
                    return cb('auto-install échoué : ' + instErr + ' — log : ' + log.slice(-10).join(' | '));
                }
                wingetExe = findWingetExe();
                if (!wingetExe) return cb('winget toujours introuvable après install');
                L('winget installé : ' + wingetExe);
                cb(null);
            }, data.bundleUrls);
        }
        // Check version : si trop vieille, upgrade.
        checkWingetVersion(wingetExe, function (ver) {
            L('winget version : ' + (ver || '?'));
            if (versionLess(ver, '1.4')) {
                L('winget trop ancien (' + ver + ') — upgrade vers la dernière');
                installWingetSystem(L, function (instErr) {
                    if (instErr) {
                        L('upgrade winget échoué : ' + instErr + ' — on continue avec l\'ancien');
                        return cb(null);
                    }
                    wingetExe = findWingetExe();
                    L('winget upgrade OK : ' + wingetExe);
                    cb(null);
                }, data.bundleUrls);
                return;
            }
            cb(null);
        });
    }
    ensureWingetReady(function (err) {
        if (err) return send({ error: err, log: log.join('\n') });
        continueInventory();
    });
    return;
    function continueInventory() {

    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    function toStr(buf) {
        if (typeof buf === 'string') return buf;
        if (!buf) return '';
        try { return buf.toString('utf8'); } catch (_) {}
        try { return String.fromCharCode.apply(null, buf); } catch (_) {}
        return '';
    }
    function parseWingetTable(txt) {
        // winget list/upgrade : format texte tabulé. On détecte la ligne
        // d'entête en cherchant un mot-clé connu ('Id' ou 'ID'), puis on
        // calcule les positions de colonnes via la position des en-têtes
        // (Name/Nom, Id, Version, Available/Disponible, Source). Plus robuste
        // que de chercher la ligne de tirets (qui peut être en Unicode box-
        // drawing ─ ou en CP1252 mojibaké).
        var lines = txt.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n').split('\n');
        var headerKeywords = ['Name', 'Nom', 'Id', 'ID', 'Version', 'Available', 'Disponible', 'Source'];
        var headerIdx = -1;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line || line.length < 10) continue;
            // Heuristique : la ligne d'en-tête contient au moins 'Id' OU 'ID'
            // entouré de séparateurs (espaces), ET 'Version'.
            if (/(^|\s)(Id|ID)(\s|$)/.test(line) && /(^|\s)Version(\s|$)/.test(line)) {
                headerIdx = i;
                break;
            }
        }
        if (headerIdx < 0) return [];
        var header = lines[headerIdx];
        // Positions de colonnes : pour chaque mot-clé connu présent dans
        // l'en-tête, on note son index de début.
        var cols = [];
        headerKeywords.forEach(function (kw) {
            var re = new RegExp('(^|\\s)' + kw + '(\\s|$)');
            var m = re.exec(header);
            if (m) cols.push({ name: kw, start: m.index + (m[1] ? m[1].length : 0) });
        });
        cols.sort(function (a, b) { return a.start - b.start; });
        if (cols.length < 2) return [];
        for (var c = 0; c < cols.length; c++) {
            cols[c].end = (c + 1 < cols.length) ? cols[c + 1].start : 9999;
        }
        // La ligne juste après l'en-tête est souvent une séparatrice (tirets ou
        // ─). On la saute si elle ne contient pas de lettres.
        var startIdx = headerIdx + 1;
        if (startIdx < lines.length && lines[startIdx] && !/[A-Za-z]/.test(lines[startIdx])) startIdx++;
        var rows = [];
        for (var k = startIdx; k < lines.length; k++) {
            var ln = lines[k];
            if (!ln || !ln.trim()) continue;
            // Messages winget de fin : « 50 upgrades available. », etc.
            if (/^\s*\d+\s+(upgrades|packages|paquets)/i.test(ln)) continue;
            // Lignes de progression / barres : pas de lettres significatives
            if (!/[A-Za-z]/.test(ln)) continue;
            var row = {};
            for (var c2 = 0; c2 < cols.length; c2++) {
                row[cols[c2].name] = (ln.substring(cols[c2].start, cols[c2].end) || '').trim();
            }
            // Une ligne valide doit avoir au moins un Id non vide
            var idVal = row.Id || row.ID;
            if (idVal && idVal.length > 1) rows.push(row);
        }
        return rows;
    }

    function runWinget(args, cb) {
        var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e9);
        var outFile = tmpRoot + '\\softctl_wgi_' + stamp + '.log';
        var batFile = tmpRoot + '\\softctl_wgi_' + stamp + '.bat';
        var line = '"' + wingetExe + '" ' + args + ' > "' + outFile + '" 2>&1';
        try { fs.writeFileSync(batFile, '@echo off\r\n' + line + '\r\n'); }
        catch (e) { return cb(e, ''); }
        var exe = windir + '\\System32\\cmd.exe';
        try {
            var child = cp.execFile(exe, ['/c', batFile]);
            var done2 = false;
            function finish(err) {
                if (done2) return; done2 = true;
                var out = '';
                try { if (fs.existsSync(outFile)) out = toStr(fs.readFileSync(outFile, 'utf8')); } catch (_) {}
                try { fs.unlinkSync(outFile); } catch (_) {}
                try { fs.unlinkSync(batFile); } catch (_) {}
                cb(err, out);
            }
            child.on('exit', function () { finish(null); });
            setTimeout(function () { try { child.kill(); } catch (_) {} finish('timeout'); }, 120 * 1000);
        } catch (e) { cb(e, ''); }
    }

    function snippet(s) {
        if (!s) return '';
        s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n');
        // Garde les 30 dernières lignes non vides après filtrage des barres de
        // progression (lignes pleines de █ ou - sans données).
        var lines = s.split('\n').map(function (x) { return x.trim(); }).filter(function (x) {
            if (!x) return false;
            if (/^[█░▒▓\s\d\.%\/MKBoG-]+$/i.test(x) && x.indexOf('|') === -1) {
                // ligne de progression : tout sauf data
                return false;
            }
            return true;
        });
        return lines.slice(-30).join('\n');
    }
    // --disable-interactivity : indispensable sous SYSTEM sans TTY, sinon
    // winget se met en mode interactif et n'affiche rien (juste le spinner).
    function doScan(retried) {
        runWinget('list --source winget --accept-source-agreements --disable-interactivity', function (err1, out1) {
            // 0x8a15000f = source manquante → on tente un reset une fois.
            if (!retried && /8a15000f|source reset/i.test(out1 || '')) {
                L('source error, reset puis retry');
                return runWinget('source reset --force', function () {
                    runWinget('source update --accept-source-agreements', function () {
                        doScan(true);
                    });
                });
            }
            var installed = parseWingetTable(out1 || '');
            // --include-unknown : ajouté en winget v1.4. Fallback sans le flag
            // si winget plus ancien (output contient "Argument name was not
            // recognized").
            runWinget('upgrade --include-unknown --source winget --accept-source-agreements --disable-interactivity', function (err2, out2) {
                if (/Argument name was not recognized/i.test(out2 || '')) {
                    L('--include-unknown non supporté (winget ancien), retry sans');
                    runWinget('upgrade --source winget --accept-source-agreements --disable-interactivity', function (_e, out2b) {
                        finalize(installed, out1, parseWingetTable(out2b || ''), out2b);
                    });
                    return;
                }
                finalize(installed, out1, parseWingetTable(out2 || ''), out2);
            });
        });
    }
    function finalize(installed, out1, upgrades, out2) {
        send({
            installed: installed,
            upgrades: upgrades,
            rawList: snippet(out1 || ''),
            rawUpgrade: snippet(out2 || ''),
        });
    }
    doScan(false);
    } // fin continueInventory
}
