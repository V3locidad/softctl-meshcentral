/*
 * softctl — Catalogue logiciels + déploiement sur les postes via MeshCentral.
 *
 * Phase 1 (cette version): catalogue lu depuis le NAS monté localement,
 * liste des agents MeshCentral, UI sélection, bouton dry-run qui affiche
 * ce qui serait poussé. Aucune commande envoyée aux agents pour l'instant.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Token store for installer downloads. The agent fetches /download?token=...
// without a session cookie, so each token is single-use, scoped to one
// installer, and expires after TOKEN_TTL_MS. After download (or timeout) the
// token is forgotten and any second attempt 403s.
const downloadTokens = {};
const uploadTokens = {};
const reportTokens = {};      // token -> { deploymentId, softId, nodeId, expires }
const inventoryWaiters = {};  // dispatchId -> { res, expires }
const wingetStatusCache = {}; // nodeId -> { hasWinget, version, tooOld, lastCheck }
const wingetCheckPending = {}; // dispatchId -> nodeId
const wingetMaintenanceState = { lastFixDispatch: {}, autoEnabled: true, baseUrl: '' };
const glpiAgentRuns = {};      // runId -> { results: { nodeId: {…} } }
const glpiAgentPending = {};   // dispatchId -> { runId, nodeId }
const GLPI_AGENT_RUN_TTL = 6 * 60 * 60 * 1000;
const WINGET_STATUS_TTL = 30 * 60 * 1000;  // 30 min de fraîcheur
const WINGET_FIX_COOLDOWN = 60 * 60 * 1000; // 1h entre 2 tentatives sur le même poste

function versionLess(a, b) {
    if (!a) return true;
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d < 0;
    }
    return false;
}
const TOKEN_TTL_MS = 30 * 60 * 1000;
const REPORT_TTL_MS = 2 * 60 * 60 * 1000;  // 2 h, le temps qu'un gros install termine

// Historique : Map en mémoire qu'on persiste sur disque à chaque mise à jour.
// On garde les 200 derniers déploiements pour ne pas faire enfler le JSON.
const deployments = {};       // id -> { id, timestamp, user, softs, nodes, results }
const HISTORY_MAX = 200;
const historyPath = () => path.join(__dirname, 'softctl-history.json');

function loadHistory() {
    try {
        const raw = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
        (raw.deployments || []).forEach((d) => { if (d && d.id) deployments[d.id] = d; });
    } catch (e) {}
}

function saveHistory() {
    try {
        const list = Object.values(deployments).sort((a, b) => b.timestamp - a.timestamp).slice(0, HISTORY_MAX);
        fs.writeFileSync(historyPath(), JSON.stringify({ deployments: list }, null, 2));
    } catch (e) {}
}

function newDownloadToken(slug, kind) {
    const t = crypto.randomBytes(24).toString('hex');
    downloadTokens[t] = { slug: slug, kind: kind || 'soft', expires: Date.now() + TOKEN_TTL_MS };
    return t;
}

function consumeDownloadToken(t) {
    const e = downloadTokens[t];
    if (!e) return null;
    if (e.expires < Date.now()) { delete downloadTokens[t]; return null; }
    // Single-shot: remove after first read so a leaked URL can't be replayed.
    delete downloadTokens[t];
    return e;
}

module.exports.softctl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    // Cherche le MSI GLPI Agent le plus récent dans bin/ et extrait sa version
    // depuis le nom de fichier (ex: "GLPI-Agent-1.13-x64.msi" → "1.13").
    function findNewestGlpiAgentMsi() {
        const binDir = path.join(__dirname, 'bin');
        let candidates = [];
        try {
            fs.readdirSync(binDir).forEach((f) => {
                if (!/^GLPI-Agent.*\.msi$/i.test(f)) return;
                const m = f.match(/GLPI-Agent[-_]?(\d+(?:\.\d+)+)/i);
                candidates.push({ path: path.join(binDir, f), version: m ? m[1] : '' });
            });
        } catch (_) {}
        if (!candidates.length) return null;
        // Tri par version desc (les versions non parseables passent en dernier)
        candidates.sort((a, b) => {
            if (!a.version) return 1;
            if (!b.version) return -1;
            const pa = a.version.split('.').map((n) => parseInt(n, 10) || 0);
            const pb = b.version.split('.').map((n) => parseInt(n, 10) || 0);
            const len = Math.max(pa.length, pb.length);
            for (let i = 0; i < len; i++) {
                const da = pa[i] || 0, db = pb[i] || 0;
                if (da !== db) return db - da;
            }
            return 0;
        });
        return candidates[0];
    }

    function loadCfg() {
        const p = path.join(__dirname, 'softctl-config.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { return null; }
    }

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
    }

    // For actions that used to POST a JSON body, we accept the same payload as
    // a `payload` query param now (the URL stays small for text actions). The
    // `?payload=` form is what the frontend sends; MC happily accepts GET.
    function readJsonParam(req) {
        const raw = (req.query && req.query.payload) || '';
        if (!raw) return {};
        try { return JSON.parse(raw); } catch (e) { return {}; }
    }

    // Walk softwareDir/<slug>/metadata.json + locate the installer file.
    // Anything missing metadata.json is skipped (with a flag in the response so
    // the UI can show "folder ignored: no metadata.json"); we don't fail the whole
    // catalogue just because one folder is malformed.
    function listCatalog() {
        const cfg = loadCfg();
        if (!cfg || !cfg.softwareDir) throw new Error('softctl-config.json manquant ou softwareDir non défini');
        const dir = cfg.softwareDir;
        if (!fs.existsSync(dir)) throw new Error('softwareDir introuvable: ' + dir);
        const out = [];
        const skipped = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const folder = path.join(dir, e.name);
            const metaPath = path.join(folder, 'metadata.json');
            if (!fs.existsSync(metaPath)) { skipped.push({ folder: e.name, reason: 'metadata.json manquant' }); continue; }
            let meta;
            try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
            catch (err) { skipped.push({ folder: e.name, reason: 'metadata.json invalide: ' + err.message }); continue; }
            // Resolve the installer: prefer the explicit field, else find the
            // first .exe/.msi/.zip in the folder. Keep filename only (no leading
            // path) so the UI doesn't leak the local mount path.
            let installer = meta.installer || '';
            if (!installer) {
                const files = fs.readdirSync(folder).filter((f) => /\.(exe|msi|zip)$/i.test(f));
                if (files.length) installer = files[0];
            }
            const installerPath = installer ? path.join(folder, installer) : '';
            const installerOk = installerPath && fs.existsSync(installerPath);
            let size = 0;
            try { if (installerOk) size = fs.statSync(installerPath).size; } catch (_) {}
            // arch peut être surchargé dans metadata.json. Sinon on devine depuis
            // le nom de fichier (et pour les .zip, depuis archiveInstaller). 'any'
            // signifie "compatible partout" (typique pour les MSI fat ou les zips).
            let arch = meta.arch || '';
            if (!arch) arch = detectArch(installer) || (meta.archiveInstaller ? detectArch(meta.archiveInstaller) : '') || '';
            out.push({
                id: e.name,
                name: meta.name || e.name,
                version: meta.version || '',
                vendor: meta.vendor || '',
                silentArgs: meta.silentArgs || '',
                installer: installer,
                installerOk: installerOk,
                size: size,
                archive: meta.archive || '',
                archiveInstaller: meta.archiveInstaller || '',
                arch: arch,
            });
        }
        out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
        return { softwares: out, skipped: skipped };
    }

    // MeshCentral agent type → human family. Used as a fallback when osdesc isn't set.
    const AGENT_TYPE = {
        1: 'Windows', 2: 'Windows', 13: 'Windows', 15: 'Windows', 16: 'Windows', 17: 'Windows ARM64',
        3: 'Linux x86', 4: 'Linux x64', 6: 'Linux ARM', 7: 'Linux MIPS', 9: 'Linux',
        10: 'Linux ARM HF', 11: 'OpenWRT', 12: 'OpenWRT', 14: 'Linux ARM', 18: 'Linux POWERPC64',
        5: 'macOS', 8: 'macOS ARM', 19: 'macOS Apple Silicon',
        20: 'FreeBSD',
    };
    // Architecture binaire de l'agent — utilisée pour matcher l'arch des installeurs.
    const AGENT_ARCH = {
        1: 'x86', 2: 'x86', 3: 'x86', 13: 'x86',
        4: 'x64', 5: 'x64', 9: 'x64', 15: 'x64', 16: 'x64', 20: 'x64',
        6: 'arm', 10: 'arm', 14: 'arm',
        8: 'arm64', 17: 'arm64', 19: 'arm64',
        7: 'mips', 18: 'ppc64', 11: '?', 12: '?',
    };

    // Devine l'arch depuis le nom du fichier installeur. Retourne '' si ambigu.
    function detectArch(installer) {
        if (!installer) return '';
        const l = String(installer).toLowerCase();
        if (/arm64|aarch64/.test(l)) return 'arm64';
        if (/(^|[_.\- ])(x64|amd64|win64|64.?bit)([_.\- ]|$)/.test(l)) return 'x64';
        if (/(^|[_.\- ])(x86|ia32|win32|32.?bit)([_.\- ]|$)/.test(l)) return 'x86';
        return '';
    }

    // List the MeshCentral agents (nodes) and the meshes ("salles") they belong to.
    // We fetch both types in one pass and resolve each node's mesh name so the UI
    // can group/select per room without a second round-trip.
    function listAgents(cb) {
        const db = obj.meshServer && obj.meshServer.db;
        if (!db || typeof db.GetAllType !== 'function') return cb(new Error('MC DB inaccessible'));
        // wsagents : map nodeId -> websocket actif. Présence = poste en ligne.
        const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
        db.GetAllType('mesh', function (meshErr, meshDocs) {
            if (meshErr) return cb(meshErr);
            const meshById = {};
            (meshDocs || []).forEach((m) => { if (m && m._id) meshById[m._id] = m.name || m._id; });
            db.GetAllType('node', function (err, docs) {
                if (err) return cb(err);
                const agents = (docs || []).filter((d) => d && d._id && (d.agent || d.osdesc)).map((d) => {
                    const family = (d.agent && AGENT_TYPE[d.agent.id]) || '';
                    const os = d.osdesc || family || '?';
                    return {
                        id: d._id,
                        name: d.name || d.host || d._id,
                        meshid: d.meshid || '',
                        mesh: meshById[d.meshid] || '',
                        os: os,
                        family: family,
                        arch: (d.agent && AGENT_ARCH[d.agent.id]) || '',
                        lastConnect: d.lastConnectTime || 0,
                        online: !!wsagents[d._id],
                    };
                });
                agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                // Surface the mesh catalogue alongside so the dropdown can be built
                // even when no agents currently belong to a particular salle.
                const meshes = Object.keys(meshById).map((id) => ({ id: id, name: meshById[id] }));
                meshes.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
                cb(null, agents, meshes);
            });
        });
    }

    // Restaure l'historique au démarrage (on persiste à chaque update).
    loadHistory();

    // ---- Maintenance Winget : scan périodique + auto-install via NAS ----
    function kickWingetScan(forceAll) {
        try {
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            Object.keys(wsagents).forEach((nid) => {
                const ws = wsagents[nid];
                if (!ws || typeof ws.send !== 'function') return;
                const cached = wingetStatusCache[nid];
                if (!forceAll && cached && (Date.now() - cached.lastCheck < WINGET_STATUS_TTL)) return;
                const dispatchId = 'wgchk-' + crypto.randomBytes(6).toString('hex');
                wingetCheckPending[dispatchId] = nid;
                try {
                    ws.send(JSON.stringify({ action: 'plugin', plugin: 'softctl', pluginaction: 'wingetCheck', dispatchId: dispatchId }));
                } catch (_) { delete wingetCheckPending[dispatchId]; }
            });
        } catch (e) { console.log('softctl: kickWingetScan err: ' + e.message); }
    }

    function kickWingetFix() {
        let boot;
        try {
            const cat = listCatalog();
            boot = (cat.softwares || []).find((s) => s.id === 'winget-bootstrap' && s.installerOk);
            if (!boot) {
                const found = (cat.softwares || []).find((s) => s.id === 'winget-bootstrap');
                console.log('softctl: kickWingetFix → bootstrap absent du catalogue' + (found ? ' (présent mais installerOk=false : fichier zip manquant?)' : ''));
                return 0;
            }
        } catch (e) {
            console.log('softctl: kickWingetFix listCatalog err: ' + e.message);
            return 0;
        }
        const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
        const targets = [];
        Object.keys(wingetStatusCache).forEach((nid) => {
            const c = wingetStatusCache[nid];
            if (!c || (c.hasWinget && !c.tooOld)) return;
            if (!wsagents[nid]) return;
            const last = wingetMaintenanceState.lastFixDispatch[nid] || 0;
            if (Date.now() - last < WINGET_FIX_COOLDOWN) return;
            targets.push(nid);
        });
        const cacheCount = Object.keys(wingetStatusCache).length;
        const onlineCount = Object.keys(wsagents).length;
        console.log('softctl: kickWingetFix → ' + targets.length + ' cibles (' + cacheCount + ' en cache, ' + onlineCount + ' en ligne, baseUrl=' + (wingetMaintenanceState.baseUrl || 'absente') + ')');
        if (!targets.length) return 0;
        if (!wingetMaintenanceState.baseUrl) {
            console.log('softctl: kickWingetFix annulé — baseUrl pas encore connue (ouvre softctl dans le browser une fois)');
            return 0;
        }
        // Dispatch via la pipeline deploy interne : on génère un deployment
        // factice qui appelle la machinerie install habituelle.
        const deploymentId = crypto.randomBytes(8).toString('hex');
        const deployment = {
            id: deploymentId,
            timestamp: Date.now(),
            user: 'auto-winget-fix',
            softs: [{ id: 'winget-bootstrap', name: 'Winget Bootstrap' }],
            nodes: targets.map((id) => ({ id: id })),
            results: {},
        };
        deployments[deploymentId] = deployment;
        const cfg = loadCfg();
        targets.forEach((nid) => {
            wingetMaintenanceState.lastFixDispatch[nid] = Date.now();
            const ws = wsagents[nid];
            if (!ws) return;
            const dispatchId = crypto.randomBytes(16).toString('hex');
            reportTokens[dispatchId] = { deploymentId: deploymentId, softId: 'winget-bootstrap', nodeId: nid, expires: Date.now() + REPORT_TTL_MS };
            try {
                const token = newDownloadToken('winget-bootstrap');
                const base = wingetMaintenanceState.baseUrl || '';
                const url = base + '/softctl-download/' + token;
                // Récupère l'installer réel depuis le catalogue (peut ne pas
                // être nommé winget-bootstrap.zip exactement)
                const installerName = (boot && boot.installer) || 'winget-bootstrap.zip';
                ws.send(JSON.stringify({
                    action: 'plugin', plugin: 'softctl', pluginaction: 'install',
                    dispatchId: dispatchId,
                    url: url,
                    installer: installerName,
                    archiveInstaller: (boot && boot.archiveInstaller) || 'install-winget.cmd',
                    silentArgs: (boot && boot.silentArgs) || '',
                }));
                deployment.results['winget-bootstrap|' + nid] = { status: 'dispatched', time: Date.now() };
                console.log('softctl: auto-fix dispatched → ' + nid.slice(0, 16) + ' (' + installerName + ')');
            } catch (e) { console.log('softctl: auto-fix err ' + nid + ': ' + e.message); }
        });
        saveHistory();
        return targets.length;
    }

    // Boucle 2 min : scan + auto-fix automatique (pas d'action utilisateur requise).
    function maintenanceTick() {
        kickWingetScan(false);
        if (wingetMaintenanceState.autoEnabled) {
            setTimeout(kickWingetFix, 10000);  // laisser arriver les résultats
        }
    }
    setInterval(maintenanceTick, 2 * 60 * 1000);
    // Premier scan 15s après démarrage MC
    setTimeout(maintenanceTick, 15000);

    // Enregistre un endpoint dédié pour les uploads, en dehors de pluginadmin.ashx
    // dont MC refuse les POST/PUT (CSRF-like). On utilise un token d'usage unique
    // pour gérer l'auth nous-mêmes — le token n'est délivré qu'à un user
    // authentifié via la route GET pluginadmin.
    // Handler appelé par MeshCentral quand un agent envoie un message
    // {action:'plugin', plugin:'softctl', pluginaction:'installComplete', ...}.
    // C'est le retour d'install : on met à jour le déploiement et l'historique.
    obj.serveraction = function (command, myparent) {
        try {
            if (!command) return;
            if (command.pluginaction === 'pong') return;
            if (command.pluginaction === 'wingetCheckResult') {
                const nid = wingetCheckPending[command.dispatchId];
                if (nid) delete wingetCheckPending[command.dispatchId];
                const targetNid = nid || command.nodeId;
                if (!targetNid) return;
                const tooOld = command.hasWinget && versionLess(command.version, '1.4');
                wingetStatusCache[targetNid] = {
                    hasWinget: !!command.hasWinget,
                    version: command.version || '',
                    tooOld: !!tooOld,
                    lastCheck: Date.now(),
                };
                return;
            }
            if (command.pluginaction === 'glpiAgentResult') {
                const did = command.dispatchId;
                if (!did) return;
                const entry = glpiAgentPending[did];
                if (!entry) return;
                delete glpiAgentPending[did];
                const run = glpiAgentRuns[entry.runId];
                if (!run) return;
                run.results[entry.nodeId] = {
                    status: command.ok ? 'done' : 'error',
                    ok: !!command.ok,
                    result: command.result || '',
                    exitCode: command.exitCode,
                    installedVersion: command.installedVersion || '',
                    desiredVersion: command.desiredVersion || '',
                    error: command.error || undefined,
                    logTail: command.logTail || '',
                    time: Date.now(),
                };
                console.log('softctl: glpiAgentResult ' + entry.nodeId + ' = ' + (command.result || (command.ok ? 'ok' : 'err')));
                return;
            }
            if (command.pluginaction === 'wingetInventoryResult') {
                const w = inventoryWaiters[command.dispatchId];
                if (!w) return;
                delete inventoryWaiters[command.dispatchId];
                try {
                    w.res.setHeader('Content-Type', 'application/json');
                    w.res.end(JSON.stringify({
                        ok: !command.error,
                        error: command.error || undefined,
                        installed: command.installed || [],
                        upgrades: command.upgrades || [],
                        rawList: command.rawList || '',
                        rawUpgrade: command.rawUpgrade || '',
                    }));
                } catch (e) {}
                return;
            }
            if (command.pluginaction !== 'installComplete') return;
            const tok = command.dispatchId;
            if (!tok) return;
            const entry = reportTokens[tok];
            if (!entry) return;  // déjà consommé ou expiré
            delete reportTokens[tok];
            const dep = deployments[entry.deploymentId];
            if (!dep) return;
            const key = entry.softId + '|' + entry.nodeId;
            dep.results[key] = {
                status: command.skipped ? 'skipped' : ((command.exit === 0) ? 'success' : 'fail'),
                exitCode: (typeof command.exit === 'number') ? command.exit : -1,
                error: command.error || undefined,
                log: command.log || undefined,
                time: Date.now(),
            };
            saveHistory();
            console.log('softctl: installComplete ' + entry.softId + ' on ' + entry.nodeId + ' exit=' + command.exit);
            // Si c'était un install de winget-bootstrap réussi → invalide
            // le cache wingetCheck et déclenche un re-check immédiat.
            if (entry.softId === 'winget-bootstrap' && command.exit === 0) {
                delete wingetStatusCache[entry.nodeId];
                try {
                    const wsa = (obj.meshServer.webserver.wsagents || {})[entry.nodeId];
                    if (wsa && typeof wsa.send === 'function') {
                        const did = 'wgchk-' + crypto.randomBytes(6).toString('hex');
                        wingetCheckPending[did] = entry.nodeId;
                        wsa.send(JSON.stringify({ action: 'plugin', plugin: 'softctl', pluginaction: 'wingetCheck', dispatchId: did }));
                    }
                } catch (_) {}
            }
        } catch (e) {
            console.log('softctl: serveraction error: ' + e.message);
        }
    };

    obj.server_startup = function () {
        const ws = obj.meshServer && obj.meshServer.webserver;
        const app = ws && ws.app;
        if (!app || typeof app.put !== 'function') {
            console.log('softctl: webserver.app inaccessible — uploads HTTP indisponibles');
            return;
        }
        // Endpoint download dédié, hors pluginadmin.ashx. MC rejette en 401 toute
        // requête à pluginadmin.ashx sans cookie de session — donc l'agent
        // (PowerShell sans cookie) ne peut pas y accéder. Notre token au porteur
        // dans l'URL nous tient lieu d'auth.
        // Endpoint dédié au MSI GLPI Agent (cherché dans bin/GLPI-Agent*.msi).
        app.get('/softctl-download/glpiagent/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = consumeDownloadToken(token);
                if (!entry || entry.kind !== 'glpiagent') {
                    return res.status(403).set('Content-Type', 'text/plain').send('forbidden');
                }
                const msi = findNewestGlpiAgentMsi();
                if (!msi) {
                    console.log('softctl: GLPI-Agent MSI absent dans ' + path.join(__dirname, 'bin'));
                    return res.status(404).set('Content-Type', 'text/plain').send('GLPI-Agent*.msi non déployé sur le serveur (placer dans plugins/softctl/bin/)');
                }
                const stat = fs.statSync(msi.path);
                res.set('Content-Type', 'application/octet-stream');
                res.set('Content-Length', stat.size);
                res.set('Content-Disposition', 'attachment; filename="' + path.basename(msi.path) + '"');
                fs.createReadStream(msi.path).pipe(res);
            } catch (e) { res.status(500).send(e.message); }
        });

        app.get('/softctl-download/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = consumeDownloadToken(token);
                if (!entry || (entry.kind && entry.kind !== 'soft')) return res.status(403).set('Content-Type', 'text/plain').send('forbidden');
                const cfg = loadCfg();
                if (!cfg || !cfg.softwareDir) return res.status(500).send('softwareDir non défini');
                const folder = path.join(cfg.softwareDir, entry.slug);
                const metaPath = path.join(folder, 'metadata.json');
                if (!fs.existsSync(metaPath)) return res.status(404).send('soft introuvable');
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (!meta.installer) return res.status(404).send('installeur non défini');
                const installerPath = path.join(folder, meta.installer);
                if (!fs.existsSync(installerPath)) return res.status(404).send('fichier installeur manquant');
                const stat = fs.statSync(installerPath);
                res.set('Content-Type', 'application/octet-stream');
                res.set('Content-Length', stat.size);
                res.set('Content-Disposition', 'attachment; filename="' + meta.installer.replace(/"/g, '') + '"');
                fs.createReadStream(installerPath).pipe(res);
            } catch (e) { res.status(500).send(e.message); }
        });

        // Même logique pour le report-back du PowerShell post-install : pas de
        // cookie côté agent, route dédiée avec token-au-porteur.
        app.get('/softctl-report/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = reportTokens[token];
                if (!entry || entry.expires < Date.now()) return res.status(404).set('Content-Type', 'text/plain').send('token invalide');
                delete reportTokens[token];
                const exitCode = parseInt(req.query.exit, 10);
                const dep = deployments[entry.deploymentId];
                if (dep) {
                    const key = entry.softId + '|' + entry.nodeId;
                    dep.results[key] = {
                        status: (exitCode === 0) ? 'success' : 'fail',
                        exitCode: isNaN(exitCode) ? -1 : exitCode,
                        time: Date.now(),
                    };
                    saveHistory();
                }
                res.status(200).set('Content-Type', 'text/plain').send('ok');
            } catch (e) { res.status(500).send(e.message); }
        });

        app.put('/softctl-upload/:token', (req, res) => {
            try {
                const token = String(req.params.token || '');
                const entry = uploadTokens[token];
                if (!entry || entry.expires < Date.now()) {
                    return res.status(403).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'token invalide ou expiré' }));
                }
                // Token à usage unique : on le brûle dès qu'on commence à écrire.
                delete uploadTokens[token];

                const cfg = loadCfg();
                if (!cfg || !cfg.softwareDir) return res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'softwareDir non défini' }));
                const folder = path.join(cfg.softwareDir, entry.slug);
                if (entry.mode === 'add') {
                    if (fs.existsSync(folder)) return res.status(409).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'slug existe déjà' }));
                    fs.mkdirSync(folder, { recursive: true });
                } else if (!fs.existsSync(folder)) {
                    return res.status(404).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'logiciel introuvable' }));
                }
                const installerPath = path.join(folder, entry.filename);
                const ws2 = fs.createWriteStream(installerPath);
                req.pipe(ws2);
                ws2.on('finish', () => {
                    // Écrit la metadata (add) ou met à jour installer (replace).
                    const metaPath = path.join(folder, 'metadata.json');
                    if (entry.mode === 'add') {
                        const meta = {
                            name: entry.name,
                            version: entry.version || '',
                            vendor: entry.vendor || '',
                            silentArgs: entry.silentArgs || '',
                            installer: entry.filename,
                        };
                        if (/\.zip$/i.test(entry.filename) && entry.archiveInstaller) meta.archiveInstaller = entry.archiveInstaller;
                        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                    } else if (entry.mode === 'replace' && fs.existsSync(metaPath)) {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                        // Si le nom du fichier change, on vire l'ancien.
                        if (meta.installer && meta.installer !== entry.filename) {
                            const oldPath = path.join(folder, meta.installer);
                            try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
                        }
                        meta.installer = entry.filename;
                        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                    }
                    res.set('Content-Type', 'application/json').send(JSON.stringify({ ok: true, slug: entry.slug, installer: entry.filename }));
                });
                ws2.on('error', (e) => res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: 'write failed: ' + e.message })));
            } catch (e) {
                res.status(500).set('Content-Type', 'application/json').send(JSON.stringify({ error: e.message }));
            }
        });
        console.log('softctl: PUT /softctl-upload/:token enregistré');
    };

    obj.handleAdminReq = function (req, res, user) {
        const action = (req.query && req.query.action) || '';

        if (action === 'ping') {
            try {
                const cat = listCatalog();
                sendJson(res, 200, { ok: true, softwares: cat.softwares.length, skipped: cat.skipped.length });
            } catch (e) {
                sendJson(res, 200, { ok: false, error: e.message });
            }
            return;
        }

        if (action === 'catalog') {
            try { sendJson(res, 200, listCatalog()); }
            catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'agents') {
            listAgents(function (err, agents, meshes) {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { agents: agents, meshes: meshes || [] });
            });
            return;
        }

        // ---- GLPI Agent deploy ----

        if (action === 'glpiAgentDeploy') {
            const cfg = loadCfg();
            if (!cfg || !cfg.glpi || !cfg.glpi.url) {
                return sendJson(res, 400, { error: 'GLPI non configuré dans softctl-config.json (clé glpi.url)' });
            }
            const body = readJsonParam(req);
            const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n) => typeof n === 'string') : [];
            const tag = body.tag || cfg.glpi.tag || '';
            const force = !!body.force;
            const glpiServer = String(cfg.glpi.url).replace(/\/+$/, '');
            if (!nodes.length) return sendJson(res, 400, { error: 'aucun poste sélectionné' });
            const msi = findNewestGlpiAgentMsi();
            if (!msi) {
                return sendJson(res, 400, { error: 'GLPI-Agent*.msi non déployé. Télécharger depuis https://github.com/glpi-project/glpi-agent/releases et placer dans ' + path.join(__dirname, 'bin') });
            }
            const desiredVersion = msi.version || '';
            const wsagents = (obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents) || {};
            const runId = crypto.randomBytes(8).toString('hex');
            const run = {
                id: runId,
                kind: 'glpiAgent',
                timestamp: Date.now(),
                user: (user && (user.name || user._id)) || 'unknown',
                glpiServer: glpiServer,
                tag: tag,
                desiredVersion: desiredVersion,
                msiName: path.basename(msi.path),
                force: force,
                results: {},
            };
            glpiAgentRuns[runId] = run;
            let dispatched = 0, offline = 0;
            const baseUrl = wingetMaintenanceState.baseUrl;
            if (!baseUrl) return sendJson(res, 500, { error: 'baseUrl serveur inconnue, recharge la page' });
            nodes.forEach((nid) => {
                const ws = wsagents[nid];
                if (!ws || typeof ws.send !== 'function') {
                    run.results[nid] = { status: 'offline', time: Date.now() };
                    offline++;
                    return;
                }
                const did = crypto.randomBytes(16).toString('hex');
                glpiAgentPending[did] = { runId: runId, nodeId: nid, expires: Date.now() + GLPI_AGENT_RUN_TTL };
                const token = newDownloadToken('glpi-agent', 'glpiagent');
                const msiUrl = baseUrl + '/softctl-download/glpiagent/' + token;
                try {
                    ws.send(JSON.stringify({
                        action: 'plugin', plugin: 'softctl', pluginaction: 'glpiAgentInstall',
                        dispatchId: did,
                        msiUrl: msiUrl,
                        glpiServer: glpiServer,
                        tag: tag,
                        desiredVersion: desiredVersion,
                        force: force,
                    }));
                    run.results[nid] = { status: 'running', time: Date.now() };
                    dispatched++;
                } catch (e) {
                    run.results[nid] = { status: 'error', error: String(e), time: Date.now() };
                }
            });
            return sendJson(res, 200, { runId: runId, dispatched: dispatched, offline: offline });
        }

        if (action === 'glpiAgentStatus') {
            const id = String((req.query && req.query.runId) || '');
            const run = glpiAgentRuns[id];
            if (!run) return sendJson(res, 404, { error: 'run inconnu' });
            // Watchdog : runs running depuis > 15 min sans heartbeat = abandonné
            const STALE = 15 * 60 * 1000;
            const now = Date.now();
            Object.keys(run.results).forEach((nid) => {
                const r = run.results[nid];
                if (r.status === 'running' && (now - (r.time || run.timestamp)) > STALE) {
                    r.status = 'aborted';
                    r.error = 'poste injoignable (>15 min sans réponse)';
                }
            });
            return sendJson(res, 200, run);
        }

        // ---- Phase 2: CRUD on the catalogue ----

        // Compute a safe folder name from a free-text input. Restricted to
        // [A-Za-z0-9_-]; everything else collapses to a single dash. Keeps the
        // generated path predictable for downloads later.
        function slugify(s) {
            return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
                .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64);
        }

        function softwareFolder(cfg, slug) {
            if (!cfg || !cfg.softwareDir) throw new Error('softwareDir non défini');
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error('slug invalide');
            return path.join(cfg.softwareDir, slug);
        }

        if (action === 'requestUploadToken') {
            // GET. Renvoie un token + URL à utiliser pour PUT le fichier. Tous les
            // champs metadata sont stockés dans le token pour ne pas avoir à les
            // re-transmettre dans la requête PUT (dont MC ne touche pas les query
            // params).
            try {
                const mode = String(req.query.mode || '').trim();  // 'add' | 'replace'
                if (mode !== 'add' && mode !== 'replace') return sendJson(res, 400, { error: 'mode invalide' });
                const cfg = loadCfg();
                if (!cfg || !cfg.softwareDir) return sendJson(res, 500, { error: 'softwareDir non défini' });
                const name = String(req.query.name || '').trim();
                const slug = slugify(req.query.slug || name);
                if (!slug || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return sendJson(res, 400, { error: 'slug invalide' });
                const filename = String(req.query.filename || '').replace(/[\\/]/g, '_').trim();
                if (!filename || !/\.(exe|msi|zip)$/i.test(filename)) return sendJson(res, 400, { error: 'filename .exe, .msi ou .zip requis' });
                if (mode === 'add' && !name) return sendJson(res, 400, { error: 'name requis pour add' });
                const token = crypto.randomBytes(24).toString('hex');
                uploadTokens[token] = {
                    expires: Date.now() + TOKEN_TTL_MS,
                    mode: mode,
                    slug: slug,
                    filename: filename,
                    name: name,
                    version: String(req.query.version || '').trim(),
                    vendor: String(req.query.vendor || '').trim(),
                    silentArgs: String(req.query.silentArgs || '').trim(),
                    archiveInstaller: String(req.query.archiveInstaller || '').replace(/^[\\/]+/, '').trim(),
                };
                sendJson(res, 200, { token: token, url: '/softctl-upload/' + token, slug: slug });
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'addSoftware') {
            // POST with the installer file as raw body, metadata in query params.
            // Streaming avoids multipart parsing and supports installers of any size.
            try {
                const cfg = loadCfg();
                const name = String(req.query.name || '').trim();
                if (!name) return sendJson(res, 400, { error: 'name requis' });
                const slug = slugify(req.query.slug || name);
                if (!slug) return sendJson(res, 400, { error: 'slug invalide' });
                const filename = String(req.query.filename || '').replace(/[\\/]/g, '_').trim();
                if (!filename || !/\.(exe|msi|zip)$/i.test(filename)) return sendJson(res, 400, { error: 'filename .exe, .msi ou .zip requis' });
                const folder = softwareFolder(cfg, slug);
                if (fs.existsSync(folder)) return sendJson(res, 409, { error: 'un logiciel avec ce slug existe déjà: ' + slug });
                fs.mkdirSync(folder, { recursive: true });
                const installerPath = path.join(folder, filename);
                const ws = fs.createWriteStream(installerPath);
                req.pipe(ws);
                ws.on('finish', () => {
                    const meta = {
                        name: name,
                        version: String(req.query.version || '').trim(),
                        vendor: String(req.query.vendor || '').trim(),
                        silentArgs: String(req.query.silentArgs || '').trim(),
                        installer: filename,
                    };
                    // Pour les .zip on demande le chemin de l'installeur principal
                    // à l'intérieur de l'archive (ex: "Anagene/setup.exe").
                    const archiveInstaller = String(req.query.archiveInstaller || '').replace(/^[\\/]+/, '').trim();
                    if (/\.zip$/i.test(filename) && archiveInstaller) meta.archiveInstaller = archiveInstaller;
                    fs.writeFileSync(path.join(folder, 'metadata.json'), JSON.stringify(meta, null, 2));
                    sendJson(res, 200, { ok: true, slug: slug });
                });
                ws.on('error', (e) => sendJson(res, 500, { error: 'write failed: ' + e.message }));
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'updateSoftware') {
            // Now GET with ?payload=<json> in the query string (MC's POST is
            // rejected by the server's CSRF-like check for plugin admin posts).
            try {
                const cfg = loadCfg();
                const slug = String(req.query.slug || '').trim();
                const folder = softwareFolder(cfg, slug);
                const metaPath = path.join(folder, 'metadata.json');
                if (!fs.existsSync(metaPath)) return sendJson(res, 404, { error: 'logiciel introuvable' });
                const current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const patch = readJsonParam(req);
                ['name', 'version', 'vendor', 'silentArgs', 'installer', 'archiveInstaller', 'arch'].forEach((k) => {
                    if (patch[k] !== undefined) current[k] = String(patch[k]).trim();
                });
                fs.writeFileSync(metaPath, JSON.stringify(current, null, 2));
                sendJson(res, 200, { ok: true, software: current });
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'replaceInstaller') {
            // POST avec le nouveau fichier en raw body. Si le nom diffère de l'ancien,
            // on supprime l'ancien et on met à jour metadata.json en conséquence.
            try {
                const cfg = loadCfg();
                const slug = String(req.query.slug || '').trim();
                const folder = softwareFolder(cfg, slug);
                const metaPath = path.join(folder, 'metadata.json');
                if (!fs.existsSync(metaPath)) return sendJson(res, 404, { error: 'logiciel introuvable' });
                const filename = String(req.query.filename || '').replace(/[\\/]/g, '_').trim();
                if (!filename || !/\.(exe|msi|zip)$/i.test(filename)) return sendJson(res, 400, { error: 'filename .exe, .msi ou .zip requis' });
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const oldInstaller = meta.installer || '';
                const newPath = path.join(folder, filename);
                const ws = fs.createWriteStream(newPath);
                req.pipe(ws);
                ws.on('finish', () => {
                    // Si on remplace par un nom différent, on vire l'ancien.
                    if (oldInstaller && oldInstaller !== filename) {
                        const oldPath = path.join(folder, oldInstaller);
                        try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
                    }
                    meta.installer = filename;
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                    sendJson(res, 200, { ok: true, installer: filename });
                });
                ws.on('error', (e) => sendJson(res, 500, { error: 'write failed: ' + e.message }));
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'deleteSoftware') {
            try {
                const cfg = loadCfg();
                const slug = String(req.query.slug || '').trim();
                const folder = softwareFolder(cfg, slug);
                if (!fs.existsSync(folder)) return sendJson(res, 404, { error: 'logiciel introuvable' });
                fs.rmSync(folder, { recursive: true, force: true });
                sendJson(res, 200, { ok: true });
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'download') {
            // Sert l'installeur d'un soft donné. Le token vient de /deploy.
            try {
                const token = String(req.query.token || '');
                const entry = consumeDownloadToken(token);
                if (!entry) return res.status(403).set('Content-Type', 'text/plain').send('forbidden');
                const cfg = loadCfg();
                const folder = softwareFolder(cfg, entry.slug);
                const metaPath = path.join(folder, 'metadata.json');
                if (!fs.existsSync(metaPath)) return res.status(404).set('Content-Type', 'text/plain').send('soft introuvable');
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (!meta.installer) return res.status(404).set('Content-Type', 'text/plain').send('installeur non défini');
                const installerPath = path.join(folder, meta.installer);
                if (!fs.existsSync(installerPath)) return res.status(404).set('Content-Type', 'text/plain').send('fichier installeur manquant');
                const stat = fs.statSync(installerPath);
                res.set('Content-Type', 'application/octet-stream');
                res.set('Content-Length', stat.size);
                res.set('Content-Disposition', 'attachment; filename="' + meta.installer.replace(/"/g, '') + '"');
                fs.createReadStream(installerPath).pipe(res);
            } catch (e) { res.status(500).send(e.message); }
            return;
        }

        if (action === 'deploy') {
            // Vrai déploiement: pour chaque soft sélectionné on génère un token
            // d'usage unique, on construit le script PS, et on l'envoie à chaque
            // agent via son WebSocket MeshCentral. Maintenant en GET via payload=…
            // pour contourner le 401 de MC sur POST.
            const payload = readJsonParam(req);
            (function () {
                const softIds = Array.isArray(payload.softIds) ? payload.softIds : [];
                const nodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds : [];
                if (!softIds.length || !nodeIds.length) return sendJson(res, 400, { error: 'softIds et nodeIds requis' });
                let cat;
                try { cat = listCatalog(); }
                catch (e) { return sendJson(res, 500, { error: e.message }); }
                const picked = cat.softwares.filter((s) => softIds.indexOf(s.id) !== -1);
                const installable = picked.filter((s) => s.installerOk);
                if (!installable.length) return sendJson(res, 400, { error: 'aucun installeur valide dans la sélection' });

                // Base URL pour l'agent. Préfère X-Forwarded-* si MC est derrière un proxy.
                const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                const baseUrl = proto + '://' + host;

                const wsagents = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
                if (!wsagents) return sendJson(res, 500, { error: 'MC wsagents inaccessible (API non standard)' });

                // Crée un déploiement et garde-trace du contexte (qui, quoi, où).
                const deploymentId = crypto.randomBytes(8).toString('hex');
                const userName = (user && (user.name || user._id)) || 'unknown';
                // Récupère le nom de chaque agent pour qu'on puisse afficher des
                // hostnames lisibles dans l'historique au lieu de "node//abc…".
                const nodeNames = {};
                if (obj.meshServer && obj.meshServer.db) {
                    nodeIds.forEach((nid) => {
                        try {
                            obj.meshServer.db.Get(nid, function (err, docs) {
                                if (!err && docs && docs[0]) {
                                    nodeNames[nid] = docs[0].name || docs[0].host || nid;
                                    const d = deployments[deploymentId];
                                    if (d) {
                                        const n = d.nodes.find((x) => x.id === nid);
                                        if (n) n.name = nodeNames[nid];
                                        saveHistory();
                                    }
                                }
                            });
                        } catch (_) {}
                    });
                }
                const deployment = {
                    id: deploymentId,
                    timestamp: Date.now(),
                    user: userName,
                    softs: installable.map((s) => ({ id: s.id, name: s.name + (s.version ? ' ' + s.version : '') })),
                    nodes: nodeIds.map((id) => ({ id: id, name: nodeNames[id] || '' })),
                    results: {},  // clé = softId + '|' + nodeId
                };

                const results = [];
                installable.forEach((s) => {
                    const token = newDownloadToken(s.id);
                    // Route dédiée /softctl-download/<token>, hors pluginadmin.ashx.
                    const url = baseUrl + '/softctl-download/' + token;

                    nodeIds.forEach((nodeId) => {
                        const key = s.id + '|' + nodeId;
                        // dispatchId = identifiant retourné par l'agent dans
                        // installComplete, qu'on stocke dans reportTokens pour
                        // retrouver le déploiement à la réception.
                        const dispatchId = crypto.randomBytes(16).toString('hex');
                        reportTokens[dispatchId] = {
                            deploymentId: deploymentId, softId: s.id, nodeId: nodeId,
                            expires: Date.now() + REPORT_TTL_MS,
                        };

                        const ws = wsagents[nodeId];
                        if (!ws || typeof ws.send !== 'function') {
                            results.push({ softId: s.id, nodeId: nodeId, ok: false, error: 'agent déconnecté' });
                            deployment.results[key] = { status: 'agent-offline', time: Date.now() };
                            return;
                        }
                        const targetKey = ws.dbNodeKey || ws.nodeid || nodeId;
                        if (targetKey !== nodeId) {
                            console.log('softctl: REJET dispatch ' + nodeId + ' — wsagent.dbNodeKey=' + targetKey);
                            results.push({ softId: s.id, nodeId: nodeId, ok: false, error: 'incohérence wsagent (ciblage refusé)' });
                            deployment.results[key] = { status: 'dispatch-failed', error: 'wsagent ciblage incohérent', time: Date.now() };
                            return;
                        }

                        // Canal plugin : MC pousse modules_meshcore/softctl.js sur
                        // l'agent au démarrage. L'agent reçoit ce message et appelle
                        // notre obj.serveraction côté meshcore qui télécharge +
                        // installe + répond avec installComplete.
                        const message = {
                            action: 'plugin',
                            plugin: 'softctl',
                            pluginaction: 'install',
                            dispatchId: dispatchId,
                            url: url,
                            installer: s.installer,
                            silentArgs: s.silentArgs || '',
                            archiveInstaller: s.archiveInstaller || '',
                        };
                        try {
                            ws.send(JSON.stringify(message));
                            console.log('softctl: install dispatched ' + s.id + ' -> ' + nodeId + ' dispatchId=' + dispatchId);
                            results.push({ softId: s.id, nodeId: nodeId, ok: true });
                            deployment.results[key] = { status: 'dispatched', time: Date.now() };
                        } catch (e) {
                            console.log('softctl: dispatch failed for ' + nodeId + ': ' + e.message);
                            results.push({ softId: s.id, nodeId: nodeId, ok: false, error: e.message });
                            deployment.results[key] = { status: 'dispatch-failed', error: e.message, time: Date.now() };
                        }
                    });
                });

                const ok = results.filter((r) => r.ok).length;
                const fail = results.length - ok;
                deployments[deploymentId] = deployment;
                saveHistory();
                sendJson(res, 200, {
                    deploymentId: deploymentId,
                    dispatched: ok,
                    failed: fail,
                    total: results.length,
                    note: ok + ' commande(s) envoyée(s), ' + fail + ' échec(s) au dispatch. Les résultats remonteront automatiquement.',
                    results: results.slice(0, 50),
                });
            })();
            return;
        }

        if (action === 'reportResult') {
            // Appelé par le PowerShell de l'agent à la fin de l'install.
            // GET pur, paramètres dans la query string. Retourne juste 'ok'.
            try {
                const token = String(req.query.token || '');
                const entry = reportTokens[token];
                if (!entry || entry.expires < Date.now()) return res.status(404).set('Content-Type', 'text/plain').send('token invalide');
                delete reportTokens[token];
                const exitCode = parseInt(req.query.exit, 10);
                const dep = deployments[entry.deploymentId];
                if (dep) {
                    const key = entry.softId + '|' + entry.nodeId;
                    dep.results[key] = {
                        status: (exitCode === 0) ? 'success' : 'fail',
                        exitCode: isNaN(exitCode) ? -1 : exitCode,
                        time: Date.now(),
                    };
                    saveHistory();
                }
                res.status(200).set('Content-Type', 'text/plain').send('ok');
            } catch (e) { res.status(500).send(e.message); }
            return;
        }

        if (action === 'cancelDeployment') {
            // On ne peut pas vraiment tuer une install Windows déjà lancée, mais on
            // peut marquer toutes les entrées en attente comme annulées et arrêter
            // le polling côté UI. Les installs déjà en cours iront à leur terme.
            const id = String(req.query.id || '');
            const d = deployments[id];
            if (!d) return sendJson(res, 404, { error: 'introuvable' });
            let n = 0;
            Object.keys(d.results || {}).forEach((k) => {
                const r = d.results[k];
                if (r && r.status !== 'success' && r.status !== 'fail') {
                    d.results[k] = { status: 'cancelled', time: Date.now() };
                    n++;
                }
            });
            saveHistory();
            sendJson(res, 200, { ok: true, cancelled: n });
            return;
        }

        if (action === 'deployment') {
            // Récupère l'état complet d'un déploiement (utilisé pour le polling UI).
            const id = String(req.query.id || '');
            const d = deployments[id];
            if (!d) return sendJson(res, 404, { error: 'introuvable' });
            sendJson(res, 200, { deployment: d });
            return;
        }

        if (action === 'selfCheck') {
            // Diagnostic : vérifie si softctl est bien enregistré côté pluginHandler
            // et si modules_meshcore est lisible. Permet de comprendre pourquoi
            // l'agent ne reçoit pas notre module meshcore.
            const fs = require('fs');
            const path = require('path');
            const ph = obj.meshServer && obj.meshServer.pluginHandler;
            const info = {
                hasPluginHandler: !!ph,
                pluginsKeys: ph ? Object.keys(ph.plugins || {}) : null,
                softctlRegistered: ph && ph.plugins && !!ph.plugins.softctl,
                pluginPath: ph ? ph.pluginPath : null,
                __dirname: __dirname,
            };
            try {
                const mp = path.join(__dirname, 'modules_meshcore');
                info.modulesMeshcoreFiles = fs.readdirSync(mp);
                info.modulesMeshcoreSize = fs.statSync(path.join(mp, 'softctl.js')).size;
            } catch (e) {
                info.modulesMeshcoreError = e.message;
            }
            return sendJson(res, 200, info);
        }

        if (action === 'pingAgent') {
            // Envoie un message plugin "ping" à un agent et attend que le module
            // meshcore softctl réponde "pong". Permet de valider la liaison
            // sans déclencher d'install.
            const nodeId = String(req.query.nodeId || '');
            const ws = obj.meshServer && obj.meshServer.webserver;
            const wsagents = ws && ws.wsagents;
            const target = wsagents && wsagents[nodeId];
            if (!target || typeof target.send !== 'function') {
                return sendJson(res, 200, { ok: false, error: 'agent introuvable/déconnecté' });
            }
            const dispatchId = 'ping-' + Date.now();
            try {
                target.send(JSON.stringify({ action: 'plugin', plugin: 'softctl', pluginaction: 'ping', dispatchId: dispatchId }));
                return sendJson(res, 200, { ok: true, dispatchId: dispatchId });
            } catch (e) {
                return sendJson(res, 200, { ok: false, error: e.message });
            }
        }

        // Cache l'URL de base à chaque requête utilisateur — utilisée par la
        // boucle background pour générer les URL de download des agents.
        try { wingetMaintenanceState.baseUrl = req.protocol + '://' + req.get('host'); } catch (_) {}

        if (action === 'wingetStatus') {
            // Renvoie le cache + flag de configuration. Déclenche aussi un scan
            // si certains postes en ligne n'ont pas de cache frais (ouverture
            // plugin = signal de présence utilisateur).
            try {
                const wsagents = (obj.meshServer.webserver.wsagents) || {};
                let needsScan = false;
                Object.keys(wsagents).forEach((nid) => {
                    const c = wingetStatusCache[nid];
                    if (!c || (Date.now() - c.lastCheck > WINGET_STATUS_TTL)) needsScan = true;
                });
                if (needsScan) {
                    kickWingetScan(false);
                    if (wingetMaintenanceState.autoEnabled) setTimeout(kickWingetFix, 10000);
                }
            } catch (_) {}
            const out = {};
            Object.keys(wingetStatusCache).forEach((nid) => {
                const c = wingetStatusCache[nid];
                if (Date.now() - c.lastCheck < WINGET_STATUS_TTL) out[nid] = c;
            });
            // Check si le soft winget-bootstrap existe au catalogue
            let hasBootstrap = false;
            try {
                const cat = listCatalog();
                hasBootstrap = (cat.softwares || []).some((s) => s.id === 'winget-bootstrap' && s.installerOk);
            } catch (_) {}
            return sendJson(res, 200, { statuses: out, hasBootstrap: hasBootstrap, autoEnabled: wingetMaintenanceState.autoEnabled });
        }

        if (action === 'wingetSetAuto') {
            wingetMaintenanceState.autoEnabled = req.query.enabled === '1';
            return sendJson(res, 200, { ok: true, autoEnabled: wingetMaintenanceState.autoEnabled });
        }

        if (action === 'wingetCheckNow') {
            // Force un scan immédiat sur tous les postes en ligne.
            kickWingetScan(true);
            return sendJson(res, 200, { ok: true });
        }

        if (action === 'wingetFixAll') {
            // Déploie winget-bootstrap sur tous les postes manquants/vieux.
            const fixed = kickWingetFix();
            return sendJson(res, 200, { ok: true, dispatched: fixed });
        }

        if (action === 'wingetInventory') {
            // Inventaire winget d'un poste : installed + upgrades dispo.
            // Réponse asynchrone : on stocke `res` dans inventoryWaiters et
            // on répond depuis serveraction quand l'agent renvoie.
            const nodeId = String(req.query.nodeId || '');
            const ws2 = obj.meshServer && obj.meshServer.webserver;
            const wsagents2 = ws2 && ws2.wsagents;
            const target = wsagents2 && wsagents2[nodeId];
            if (!target || typeof target.send !== 'function') {
                return sendJson(res, 200, { ok: false, error: 'agent introuvable/déconnecté' });
            }
            const dispatchId = 'inv-' + crypto.randomBytes(8).toString('hex');
            inventoryWaiters[dispatchId] = { res: res, expires: Date.now() + 180000 };
            // GC : si l'agent ne répond pas dans 3 min, on libère et on
            // renvoie un timeout pour ne pas garder le HTTP pendu.
            setTimeout(function () {
                const w = inventoryWaiters[dispatchId];
                if (!w) return;
                delete inventoryWaiters[dispatchId];
                try { sendJson(w.res, 200, { ok: false, error: 'timeout agent (3 min)' }); } catch (_) {}
            }, 180000);
            try {
                target.send(JSON.stringify({ action: 'plugin', plugin: 'softctl', pluginaction: 'wingetInventory', dispatchId: dispatchId }));
            } catch (e) {
                delete inventoryWaiters[dispatchId];
                return sendJson(res, 200, { ok: false, error: e.message });
            }
            return;
        }

        if (action === 'wingetCatalog') {
            // Catalogue winget (apps prédéfinies). Source : winget-catalog.json
            // copié de l'ex-plugin wingetctl. Pas de matériel à héberger, juste
            // des packageId que l'agent passera à winget.exe.
            try {
                const file = path.join(__dirname, 'winget-catalog.json');
                sendJson(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        if (action === 'wingetSearch') {
            // Recherche en ligne dans le dépôt winget public. On passe par
            // l'API communautaire api.winget.run qui sert d'index public au
            // dépôt Microsoft (utilisée par winstall.app, etc.). On la
            // requête côté serveur (pas de CORS, et l'agent n'a pas besoin
            // d'être online pour l'index).
            const q = String((req.query && req.query.q) || '').trim();
            if (q.length < 2) return sendJson(res, 400, { error: 'requête trop courte (min 2 caractères)' });
            const https = require('https');
            const opts = {
                host: 'api.winget.run',
                path: '/v2/packages?query=' + encodeURIComponent(q) + '&take=40',
                headers: { 'User-Agent': 'softctl-meshcentral', 'Accept': 'application/json' },
                timeout: 8000,
            };
            const reqWg = https.get(opts, (r) => {
                let buf = '';
                r.on('data', (c) => { buf += c; });
                r.on('end', () => {
                    try {
                        const data = JSON.parse(buf);
                        const arr = (data && (data.Packages || data.packages)) || [];
                        const list = arr.map((p) => ({
                            id: p.Id || p.id || '',
                            name: (p.Latest && p.Latest.Name) || p.Name || p.id || '',
                            publisher: (p.Latest && p.Latest.Publisher) || p.Publisher || '',
                            version: (p.Latest && p.Latest.Version) || p.Version || '',
                            description: (p.Latest && p.Latest.Description) || '',
                        })).filter((x) => x.id);
                        sendJson(res, 200, { results: list });
                    } catch (e) { sendJson(res, 502, { error: 'réponse invalide: ' + e.message }); }
                });
            });
            reqWg.on('timeout', () => { try { reqWg.destroy(); } catch (_) {} sendJson(res, 504, { error: 'timeout api.winget.run' }); });
            reqWg.on('error', (e) => sendJson(res, 502, { error: 'api.winget.run: ' + e.message }));
            return;
        }

        if (action === 'wingetDeploy') {
            // Déploiement winget : on réutilise toute la machinerie de tracking
            // existante (deployments + reportTokens + installComplete). Chaque
            // package est représenté comme un "soft" virtuel d'id 'winget:<pkg>'
            // pour que l'historique et le polling UI fonctionnent à l'identique.
            const payload = readJsonParam(req);
            let packageIds = Array.isArray(payload.packageIds) ? payload.packageIds : [];
            const nodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds : [];
            const mode = ['install','uninstall','upgrade','upgrade-all'].indexOf(payload.mode) !== -1 ? payload.mode : 'install';
            const force = !!payload.force;
            if (!nodeIds.length) return sendJson(res, 400, { error: 'nodeIds requis' });
            // upgrade-all : pas de packageIds, on en fabrique un virtuel '*'
            // pour passer dans la boucle ci-dessous (un dispatch par node).
            if (mode === 'upgrade-all') packageIds = ['*'];
            else if (!packageIds.length) return sendJson(res, 400, { error: 'packageIds requis' });

            // Charge le catalogue pour récupérer le nom lisible de chaque app.
            let nameById = {};
            try {
                const cat = JSON.parse(fs.readFileSync(path.join(__dirname, 'winget-catalog.json'), 'utf8'));
                (cat.categories || []).forEach((c) => (c.apps || []).forEach((a) => { nameById[a.id] = a.name || a.id; }));
            } catch (_) {}

            const wsagents = obj.meshServer && obj.meshServer.webserver && obj.meshServer.webserver.wsagents;
            if (!wsagents) return sendJson(res, 500, { error: 'MC wsagents inaccessible' });

            const deploymentId = crypto.randomBytes(8).toString('hex');
            const userName = (user && (user.name || user._id)) || 'unknown';
            const nodeNames = {};
            if (obj.meshServer && obj.meshServer.db) {
                nodeIds.forEach((nid) => {
                    try {
                        obj.meshServer.db.Get(nid, function (err, docs) {
                            if (!err && docs && docs[0]) {
                                nodeNames[nid] = docs[0].name || docs[0].host || nid;
                                const d = deployments[deploymentId];
                                if (d) {
                                    const n = d.nodes.find((x) => x.id === nid);
                                    if (n) n.name = nodeNames[nid];
                                    saveHistory();
                                }
                            }
                        });
                    } catch (_) {}
                });
            }

            const deployment = {
                id: deploymentId,
                timestamp: Date.now(),
                user: userName,
                softs: packageIds.map((pid) => {
                    const prefix = (mode === 'uninstall') ? '[winget × ] '
                                 : (mode === 'upgrade') ? '[winget ↑] '
                                 : (mode === 'upgrade-all') ? '[winget ↑ all] '
                                 : '[winget] ';
                    const label = (pid === '*') ? 'tous les paquets' : (nameById[pid] || pid);
                    return { id: 'winget:' + pid + ':' + mode, name: prefix + label };
                }),
                nodes: nodeIds.map((id) => ({ id: id, name: nodeNames[id] || '' })),
                results: {},
            };

            const results = [];
            packageIds.forEach((pid) => {
                const virtSoftId = 'winget:' + pid + ':' + mode;
                nodeIds.forEach((nodeId) => {
                    const key = virtSoftId + '|' + nodeId;
                    const dispatchId = crypto.randomBytes(16).toString('hex');
                    reportTokens[dispatchId] = {
                        deploymentId: deploymentId, softId: virtSoftId, nodeId: nodeId,
                        expires: Date.now() + REPORT_TTL_MS,
                    };
                    const ws = wsagents[nodeId];
                    if (!ws || typeof ws.send !== 'function') {
                        results.push({ packageId: pid, nodeId: nodeId, ok: false, error: 'agent déconnecté' });
                        deployment.results[key] = { status: 'agent-offline', time: Date.now() };
                        return;
                    }
                    const targetKey = ws.dbNodeKey || ws.nodeid || nodeId;
                    if (targetKey !== nodeId) {
                        results.push({ packageId: pid, nodeId: nodeId, ok: false, error: 'incohérence wsagent' });
                        deployment.results[key] = { status: 'dispatch-failed', error: 'wsagent ciblage incohérent', time: Date.now() };
                        return;
                    }
                    const message = {
                        action: 'plugin', plugin: 'softctl',
                        pluginaction: 'wingetInstall',
                        dispatchId: dispatchId,
                        packageId: pid,
                        mode: mode,
                        force: force,
                    };
                    try {
                        ws.send(JSON.stringify(message));
                        results.push({ packageId: pid, nodeId: nodeId, ok: true });
                        deployment.results[key] = { status: 'dispatched', time: Date.now() };
                    } catch (e) {
                        results.push({ packageId: pid, nodeId: nodeId, ok: false, error: e.message });
                        deployment.results[key] = { status: 'dispatch-failed', error: e.message, time: Date.now() };
                    }
                });
            });

            const ok = results.filter((r) => r.ok).length;
            const fail = results.length - ok;
            deployments[deploymentId] = deployment;
            saveHistory();
            sendJson(res, 200, {
                deploymentId: deploymentId,
                dispatched: ok, failed: fail, total: results.length,
                note: ok + ' commande(s) winget envoyée(s), ' + fail + ' échec(s).',
                results: results.slice(0, 50),
            });
            return;
        }

        if (action === 'history') {
            // Liste les 50 derniers déploiements (triés par date desc).
            const list = Object.values(deployments)
                .sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)
                .map((d) => {
                    const counts = { dispatched: 0, success: 0, fail: 0, skipped: 0, pending: 0, offline: 0 };
                    Object.values(d.results || {}).forEach((r) => {
                        if (r.status === 'success') counts.success++;
                        else if (r.status === 'fail') counts.fail++;
                        else if (r.status === 'skipped') counts.skipped++;
                        else if (r.status === 'agent-offline' || r.status === 'dispatch-failed') counts.offline++;
                        else counts.pending++;
                        counts.dispatched++;
                    });
                    return {
                        id: d.id, timestamp: d.timestamp, user: d.user,
                        softs: d.softs, nodes: d.nodes, counts: counts,
                    };
                });
            sendJson(res, 200, { deployments: list });
            return;
        }

        if (action === 'clearHistory') {
            // Vide tout l'historique des déploiements.
            const n = Object.keys(deployments).length;
            Object.keys(deployments).forEach((k) => { delete deployments[k]; });
            saveHistory();
            console.log('softctl: history cleared (' + n + ' entrées)');
            return sendJson(res, 200, { ok: true, cleared: n });
        }

        if (action === 'clearNodeHistory') {
            // Retire un node donné de tous les déploiements de l'historique.
            // Si un déploiement ne ciblait que ce node, l'entrée est supprimée.
            const nodeId = String(req.query.nodeId || '');
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            let removed = 0, trimmed = 0;
            Object.keys(deployments).forEach((depId) => {
                const d = deployments[depId];
                const nodes = (d.nodes || []).filter((n) => n.id === nodeId);
                if (!nodes.length) return;
                const remaining = (d.nodes || []).filter((n) => n.id !== nodeId);
                if (!remaining.length) {
                    delete deployments[depId];
                    removed++;
                } else {
                    d.nodes = remaining;
                    Object.keys(d.results || {}).forEach((k) => {
                        if (k.endsWith('|' + nodeId)) delete d.results[k];
                    });
                    trimmed++;
                }
            });
            saveHistory();
            console.log('softctl: nodeHistory cleared ' + nodeId + ' (' + removed + ' supprimés, ' + trimmed + ' allégés)');
            return sendJson(res, 200, { ok: true, removed: removed, trimmed: trimmed });
        }

        if (action === 'nodeHistory') {
            // Historique des déploiements ayant ciblé un node donné.
            // Renvoie pour chaque déploiement : date, user, soft(s), status pour ce node.
            const nodeId = String(req.query.nodeId || '');
            if (!nodeId) return sendJson(res, 400, { error: 'nodeId requis' });
            const list = Object.values(deployments)
                .filter((d) => (d.nodes || []).some((n) => n.id === nodeId))
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 100)
                .map((d) => {
                    const items = (d.softs || []).map((s) => {
                        const key = s.id + '|' + nodeId;
                        const r = (d.results || {})[key] || { status: 'pending' };
                        return {
                            softId: s.id, softName: s.name,
                            status: r.status, exitCode: r.exitCode,
                            error: r.error,
                        };
                    });
                    return { id: d.id, timestamp: d.timestamp, user: d.user, items: items };
                });
            sendJson(res, 200, { deployments: list });
            return;
        }

        if (action === 'dryRun') {
            // Aperçu sans rien envoyer. GET avec payload=… (JSON encodé).
            try {
                const payload = readJsonParam(req);
                const softIds = Array.isArray(payload.softIds) ? payload.softIds : [];
                const nodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds : [];
                const cat = listCatalog();
                const picked = cat.softwares.filter((s) => softIds.indexOf(s.id) !== -1);
                sendJson(res, 200, {
                    plan: picked.map((s) => ({
                        software: s.name + (s.version ? ' ' + s.version : ''),
                        installer: s.installer,
                        silentArgs: s.silentArgs,
                        archiveInstaller: s.archiveInstaller,
                        nodes: nodeIds.length,
                    })),
                    note: 'Aperçu uniquement, aucune commande envoyée aux agents.',
                });
            } catch (e) { sendJson(res, 500, { error: e.message }); }
            return;
        }

        // Default (no action): render the plugin's handlebars view.
        res.render(path.join(__dirname, 'views/softctl'), { user: user });
    };

    return obj;
};
