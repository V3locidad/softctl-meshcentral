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
            case 'wingetCheck':
                doWingetCheck(args);
                return 'check started';
            case 'glpiAgentInstall':
                doGlpiAgentInstall(args);
                return 'glpiAgentInstall started';
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

// Déploiement silencieux de GLPI Agent (MSI). Flow :
// 1. Lit la version installée (registre)
// 2. Compare à la version cible (envoyée par le serveur depuis le nom du MSI)
// 3. Décide : install fresh, upgrade, skip+inventory, ou skip si déjà à jour
// 4. Si force=true → MSI quoi qu'il arrive
function doGlpiAgentInstall(data) {
    if (process.platform !== 'win32') {
        reply({ pluginaction: 'glpiAgentResult', dispatchId: data.dispatchId, ok: false, error: 'Windows only' });
        return;
    }
    var fs = require('fs');
    var cp = require('child_process');
    var dispatchId = data.dispatchId;
    var msiUrl = data.msiUrl || '';
    var server = data.glpiServer || '';
    var tag = data.tag || '';
    var desiredVersion = data.desiredVersion || '';
    var force = !!data.force;
    var log = [];
    function L(m) { log.push(m); dbg(m); }
    function done(ok, result, exitCode, installedVersion, err) {
        reply({
            pluginaction: 'glpiAgentResult',
            dispatchId: dispatchId,
            ok: !!ok,
            result: result || (ok ? 'ok' : 'fail'),
            exitCode: (typeof exitCode === 'number') ? exitCode : -1,
            installedVersion: installedVersion || '',
            desiredVersion: desiredVersion,
            error: err ? String(err) : undefined,
            logTail: log.slice(-40).join('\n'),
        });
    }
    if (!msiUrl || !server) return done(false, 'missing_params', -1, '', 'msiUrl et glpiServer requis');

    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var tmpRoot = (process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp');
    var msiPath = tmpRoot + '\\softctl_glpi_agent.msi';

    function runPs(script, timeoutMs, cb) {
        var ps1 = tmpRoot + '\\softctl_glpi_' + Date.now() + '.ps1';
        try { fs.writeFileSync(ps1, script); }
        catch (e) { return cb(-1, '', 'write ps1: ' + e); }
        var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ended = false;
        var out = '';
        var child;
        try {
            child = cp.execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', ps1]);
        } catch (e) {
            try { fs.unlinkSync(ps1); } catch (_) {}
            return cb(-1, '', 'spawn ps: ' + e);
        }
        if (child.stdout) child.stdout.on('data', function (d) { out += d.toString(); });
        if (child.stderr) child.stderr.on('data', function (d) { out += d.toString(); });
        child.on('exit', function (code) {
            if (ended) return; ended = true;
            try { fs.unlinkSync(ps1); } catch (_) {}
            cb(code, out, null);
        });
        setTimeout(function () {
            if (ended) return; ended = true;
            try { child.kill(); } catch (_) {}
            try { fs.unlinkSync(ps1); } catch (_) {}
            cb(-2, out, 'timeout');
        }, timeoutMs);
    }

    // Étape 1 : détecte la version installée (sans rien télécharger).
    // GLPI Agent v1.6.x stocke la version dans HKLM\SOFTWARE\GLPI-Agent\Installer\Version,
    // les nouvelles versions parfois à un autre endroit. On essaye plusieurs paths
    // puis fallback sur DisplayVersion du registre Uninstall.
    var detectPs = ''
        + '$ErrorActionPreference = "SilentlyContinue";'
        + '$installed = $null;'
        + 'foreach ($p in @('
        + '  "HKLM:\\SOFTWARE\\GLPI-Agent\\Installer",'
        + '  "HKLM:\\SOFTWARE\\WOW6432Node\\GLPI-Agent\\Installer",'
        + '  "HKLM:\\SOFTWARE\\GLPI-Agent",'
        + '  "HKLM:\\SOFTWARE\\WOW6432Node\\GLPI-Agent"'
        + ')) {'
        + '  if (Test-Path $p) {'
        + '    $v = (Get-ItemProperty -Path $p).Version;'
        + '    if ($v) { $installed = $v; break }'
        + '  }'
        + '}'
        + 'if (-not $installed) {'
        + '  foreach ($u in @("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall","HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall")) {'
        + '    $hit = Get-ChildItem $u -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like "*GLPI*Agent*" } | Select-Object -First 1;'
        + '    if ($hit -and $hit.DisplayVersion) { $installed = $hit.DisplayVersion; break }'
        + '  }'
        + '}'
        + 'Write-Host ("INSTALLED:" + $installed);';

    runPs(detectPs, 30 * 1000, function (code, out, err) {
        if (err) { L('detect err: ' + err); return done(false, 'detect_failed', -1, '', err); }
        var mInst = (out || '').match(/INSTALLED:([^\r\n]*)/);
        var installedVersion = (mInst && mInst[1] && mInst[1] !== '') ? mInst[1].trim() : '';
        L('installed version: ' + (installedVersion || '(none)') + ' / desired: ' + (desiredVersion || '(any)'));

        // Étape 2 : décide quoi faire
        var action = ''; var reason = '';
        if (!installedVersion) { action = 'install'; reason = 'not_installed'; }
        else if (force)        { action = 'install'; reason = 'forced_reinstall'; }
        else if (desiredVersion) {
            var cmp = compareVersions(installedVersion, desiredVersion);
            if (cmp < 0)       { action = 'install'; reason = 'upgrade_' + installedVersion + '_to_' + desiredVersion; }
            else if (cmp === 0){ action = 'inventory'; reason = 'already_current_' + installedVersion; }
            else               { action = 'inventory'; reason = 'installed_newer_' + installedVersion; }
        } else                 { action = 'inventory'; reason = 'already_installed_' + installedVersion; }
        L('decision: ' + action + ' (' + reason + ')');

        if (action === 'inventory') {
            // Skip MSI, lance juste un inventaire
            var pf = process.env.ProgramFiles || 'C:\\Program Files';
            var exe1 = pf + '\\GLPI-Agent\\perl\\bin\\glpi-agent.bat';
            var exe2 = pf + '\\GLPI-Agent\\glpi-agent.bat';
            var exe = fs.existsSync(exe1) ? exe1 : (fs.existsSync(exe2) ? exe2 : '');
            if (!exe) return done(true, 'skip_no_exe_found', 0, installedVersion);
            var invPs = '& cmd.exe /c \'"' + exe.replace(/'/g, "''") + '" --force\' | Out-String | Write-Host;';
            runPs(invPs, 5 * 60 * 1000, function (icode, iout, ierr) {
                L('inventory: ' + (iout || '').slice(0, 300));
                done(icode === 0, reason, icode, installedVersion, ierr || undefined);
            });
            return;
        }

        // action === 'install' : télécharge le MSI puis lance msiexec
        try { if (fs.existsSync(msiPath)) fs.unlinkSync(msiPath); } catch (e) {}
        L('download MSI : ' + msiUrl);
        download(msiUrl, msiPath, function (derr) {
            if (derr) { L('download err: ' + derr); return done(false, 'download_failed', -1, installedVersion, derr); }
            try {
                var st = fs.statSync(msiPath);
                L('MSI ok, ' + st.size + ' bytes');
                if (!st.size) return done(false, 'msi_empty', -1, installedVersion, 'MSI vide');
            } catch (e) { return done(false, 'msi_stat_failed', -1, installedVersion, e); }

            var msiLog = tmpRoot + '\\softctl_glpi_msi.log';
            try { if (fs.existsSync(msiLog)) fs.unlinkSync(msiLog); } catch (_) {}

            // Deux modes d'install :
            //  - Fresh (rien installé)  → ADDLOCAL=ALL : ajoute toutes les
            //    features dispo dans ce MSI (noms varient entre versions :
            //    feat_INVENTORY, feat_NETWORKINVENTORY, etc.).
            //  - Upgrade (déjà installé) → pas d'ADDLOCAL, pas de REINSTALL.
            //    Le MajorUpgrade WiX du MSI détecte l'ancienne version,
            //    la désinstalle et installe la nouvelle automatiquement.
            //    Les propriétés SERVER/TAG/RUNNOW sont reprises.
            var args = ['/i', msiPath, '/qn', '/norestart',
                '/L*v', msiLog,
                'SERVER=' + server,
                'RUNNOW=1'];
            if (tag) args.push('TAG=' + tag);
            if (!installedVersion) {
                args.push('ADDLOCAL=ALL');
            }
            L('msiexec ' + args.join(' '));

            // 1603 = file in use → le service GLPI-Agent en cours d'exécution
            // tient les fichiers. On stoppe le service avant l'install, et on
            // gère l'éventuelle uninstall préalable d'une vieille version
            // (1.6.x ne supporte pas toujours l'upgrade in-place via UpgradeCode).
            // Logging verbose MSI activé pour diagnostiquer si rebelote.
            var argsLit = args.map(function (a) { return "'" + a.replace(/'/g, "''") + "'"; }).join(',');
            var msiPs = ''
                + '$ErrorActionPreference = "Continue";'
                // Stoppe tout service GLPI-Agent existant et processus glpi-agent
                + 'foreach ($svc in @("GLPI-Agent","glpi-agent","glpi-agent-monitor")) {'
                + '  try {'
                + '    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue;'
                + '    if ($s -and $s.Status -ne "Stopped") {'
                + '      Write-Host ("STOP_SVC:" + $svc);'
                + '      Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue;'
                + '    }'
                + '  } catch {}'
                + '}'
                + 'Get-Process -Name "glpi-agent*","perl" -ErrorAction SilentlyContinue | ForEach-Object {'
                + '  Write-Host ("KILL_PROC:" + $_.Name);'
                + '  try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}'
                + '}'
                + 'Start-Sleep -Seconds 3;'
                // Lance msiexec
                + 'try {'
                + '  $p = Start-Process -FilePath "msiexec.exe" -ArgumentList @(' + argsLit + ')'
                + '    -Wait -PassThru -WindowStyle Hidden;'
                + '  Write-Host ("MSI_EXIT:" + [int]$p.ExitCode);'
                + '} catch {'
                + '  Write-Host ("MSI_ERR:" + $_.Exception.Message);'
                + '  exit 1;'
                + '}';
            runPs(msiPs, 15 * 60 * 1000, function (pcode, out, perr) {
                try { fs.unlinkSync(msiPath); } catch (_) {}
                if (perr) { L('msi ps err: ' + perr); return done(false, 'msiexec_wrapper_failed', -1, installedVersion, perr); }
                var exitM = (out || '').match(/MSI_EXIT:(-?\d+)/);
                var mcode = exitM ? parseInt(exitM[1], 10) : pcode;
                L('msiexec exit ' + mcode + ' (raw out: ' + (out || '').slice(0, 500) + ')');
                if (mcode !== 0 && mcode !== 3010) {
                    // Capture les dernières lignes du log MSI pour diagnostiquer
                    try {
                        var raw = fs.readFileSync(msiLog).toString();
                        // Cherche les lignes d'erreur typiques (CustomAction, Error, return value 3)
                        var errLines = raw.split(/\r?\n/).filter(function (line) {
                            return /error|return value 3|MainEngineThread|CustomAction.*returned actual error/i.test(line);
                        }).slice(-10);
                        L('MSI log tail:\n' + errLines.join('\n'));
                    } catch (e) { L('msi log read err: ' + e); }
                }
                try { fs.unlinkSync(msiLog); } catch (_) {}
                var resStr = (mcode === 0) ? ('installed_' + (desiredVersion || 'msi'))
                           : (mcode === 3010) ? 'installed_reboot_required'
                           : 'msiexec_failed_' + mcode;
                var ok = (mcode === 0 || mcode === 3010);
                done(ok, resStr, mcode, installedVersion, ok ? undefined : ('msiexec exit ' + mcode));
            });
        });
    });
}

// Compare versions sémantiques "1.10.5" vs "1.13" → renvoie < 0, 0, > 0.
function compareVersions(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    var pa = String(a).split(/[.\-_]/).map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b).split(/[.\-_]/).map(function (n) { return parseInt(n, 10) || 0; });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
        var da = pa[i] || 0, db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

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
            // Extraction via PowerShell Expand-Archive : plus fiable que tar
            // sur les .zip Windows et permet de capturer stderr.
            var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
            var psExe = windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            var extractLog = tmpDir + pathSep + 'extract.log';
            var extractBat = tmpDir + pathSep + 'extract.bat';
            var psLine = '"' + psExe + '" -NoProfile -ExecutionPolicy Bypass -NonInteractive'
                       + ' -Command "Expand-Archive -LiteralPath \'' + downloadPath + '\' -DestinationPath \'' + extractDir + '\' -Force"';
            try { fs.writeFileSync(extractBat, '@echo off\r\n' + psLine + ' > "' + extractLog + '" 2>&1\r\n'); }
            catch (e) { L('write extractBat: ' + e); return done(-1, 'extractBat: ' + e); }
            L('extract via Expand-Archive');
            try {
                var extChild = cp.execFile(windir + '\\System32\\cmd.exe', ['/c', extractBat]);
                var extDone = false;
                function onExtExit(code) {
                    if (extDone) return; extDone = true;
                    var stderr = '';
                    try { if (fs.existsSync(extractLog)) stderr = fs.readFileSync(extractLog, 'utf8').toString(); } catch (_) {}
                    try { fs.unlinkSync(extractLog); } catch (_) {}
                    try { fs.unlinkSync(extractBat); } catch (_) {}
                    if (code !== 0) {
                        L('extract exit ' + code + ' : ' + (stderr || '(vide)').replace(/\r/g, '').slice(-400));
                        return done(-1, 'extract exit ' + code);
                    }
                    var target = extractDir + pathSep + archiveInstaller.replace(/\//g, pathSep);
                    if (!fs.existsSync(target)) { L('cible non trouvée: ' + target); return done(-1, 'cible introuvable dans le zip'); }
                    L('extract OK, lancement: ' + target);
                    runInstaller(target, silentArgs, L, done);
                }
                extChild.on('exit', onExtExit);
                setTimeout(function () {
                    if (extDone) return;
                    try { extChild.kill(); } catch (_) {}
                    extDone = true;
                    L('extract timeout 10 min'); done(-1, 'extract timeout');
                }, 10 * 60 * 1000);
            } catch (e) {
                L('extract spawn err: ' + e); done(-1, e);
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
        // --source winget : sur certains postes la source msstore est cassée
        // (TLS cert mismatch). Sans ce flag winget bail avec 0x8A15005E
        // « Please specify --source ». On ne vise que la source winget.
        cmdLine += ' --source winget';
    }
    cmdLine += ' --silent --accept-source-agreements --accept-package-agreements';
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

function doWingetInventory(data) {
    // Récupère la liste des paquets installés (winget list) et la liste des
    // mises à jour disponibles (winget upgrade --include-unknown). Renvoyé
    // au serveur via pluginaction='wingetInventoryResult' avec un dispatchId.
    var fs = require('fs');
    var cp = require('child_process');
    var dispatchId = data.dispatchId;
    function send(payload) {
        var p = { pluginaction: 'wingetInventoryResult', dispatchId: dispatchId };
        Object.keys(payload).forEach(function (k) { p[k] = payload[k]; });
        reply(p);
    }
    var windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
    var programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    var wingetExe = '';
    try {
        var wapps = programFiles + '\\WindowsApps';
        var entries = fs.readdirSync(wapps);
        for (var i = 0; i < entries.length; i++) {
            if (/^Microsoft\.DesktopAppInstaller_/i.test(entries[i])) {
                var c = wapps + '\\' + entries[i] + '\\winget.exe';
                if (fs.existsSync(c)) { wingetExe = c; break; }
            }
        }
    } catch (e) {}
    if (!wingetExe) return send({ error: 'winget non installé (App Installer requis)' });

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
    runWinget('list --source winget --accept-source-agreements', function (err1, out1) {
        var installed = parseWingetTable(out1 || '');
        runWinget('upgrade --include-unknown --source winget --accept-source-agreements', function (err2, out2) {
            var upgrades = parseWingetTable(out2 || '');
            send({
                installed: installed,
                upgrades: upgrades,
                rawList: snippet(out1 || ''),
                rawUpgrade: snippet(out2 || ''),
            });
        });
    });
}

function doWingetCheck(data) {
    // Check ultra-rapide : scan WindowsApps pour Microsoft.DesktopAppInstaller
    // et remonte la version trouvée. Pas de PowerShell, pas de réseau.
    var fs = require('fs');
    var dispatchId = data.dispatchId;
    var programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    var found = '', version = '';
    try {
        var wapps = programFiles + '\\WindowsApps';
        var entries = fs.readdirSync(wapps);
        var matches = [];
        for (var i = 0; i < entries.length; i++) {
            var m = entries[i].match(/^Microsoft\.DesktopAppInstaller_([\d.]+)_/i);
            if (!m) continue;
            var p = wapps + '\\' + entries[i] + '\\winget.exe';
            if (fs.existsSync(p)) matches.push({ p: p, v: m[1] });
        }
        if (matches.length) {
            matches.sort(function (a, b) {
                var pa = a.v.split('.').map(function (n) { return parseInt(n, 10) || 0; });
                var pb = b.v.split('.').map(function (n) { return parseInt(n, 10) || 0; });
                for (var k = 0; k < Math.max(pa.length, pb.length); k++) {
                    var d = (pb[k] || 0) - (pa[k] || 0);
                    if (d !== 0) return d;
                }
                return 0;
            });
            found = matches[0].p;
            version = matches[0].v;
        }
    } catch (e) {}
    reply({
        pluginaction: 'wingetCheckResult',
        dispatchId: dispatchId,
        hasWinget: !!found,
        version: version,
        exePath: found,
    });
}
