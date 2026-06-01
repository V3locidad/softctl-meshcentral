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
const TOKEN_TTL_MS = 30 * 60 * 1000;

function newDownloadToken(slug) {
    const t = crypto.randomBytes(24).toString('hex');
    downloadTokens[t] = { slug: slug, expires: Date.now() + TOKEN_TTL_MS };
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

    function loadCfg() {
        const p = path.join(__dirname, 'softctl-config.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { return null; }
    }

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
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

    // List the MeshCentral agents (nodes) and the meshes ("salles") they belong to.
    // We fetch both types in one pass and resolve each node's mesh name so the UI
    // can group/select per room without a second round-trip.
    function listAgents(cb) {
        const db = obj.meshServer && obj.meshServer.db;
        if (!db || typeof db.GetAllType !== 'function') return cb(new Error('MC DB inaccessible'));
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
                        lastConnect: d.lastConnectTime || 0,
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

    obj.server_startup = function () {};

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
            // POST JSON body with the fields to overwrite. The installer file is
            // never touched here — replacing the binary requires a separate
            // re-upload via addSoftware (delete + add).
            let body = '';
            req.on('data', (c) => { body += c.toString('utf8'); });
            req.on('end', () => {
                try {
                    const cfg = loadCfg();
                    const slug = String(req.query.slug || '').trim();
                    const folder = softwareFolder(cfg, slug);
                    const metaPath = path.join(folder, 'metadata.json');
                    if (!fs.existsSync(metaPath)) return sendJson(res, 404, { error: 'logiciel introuvable' });
                    const current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    const patch = JSON.parse(body || '{}');
                    // Only allow whitelisted keys; ignore anything else.
                    ['name', 'version', 'vendor', 'silentArgs', 'installer', 'archiveInstaller'].forEach((k) => {
                        if (patch[k] !== undefined) current[k] = String(patch[k]).trim();
                    });
                    fs.writeFileSync(metaPath, JSON.stringify(current, null, 2));
                    sendJson(res, 200, { ok: true, software: current });
                } catch (e) { sendJson(res, 500, { error: e.message }); }
            });
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
            // agent via son WebSocket MeshCentral. On retourne immédiatement le
            // nombre de dispatches OK/KO (sans attendre le code retour de l'install).
            let body = '';
            req.on('data', (c) => { body += c.toString('utf8'); });
            req.on('end', () => {
                let payload;
                try { payload = JSON.parse(body || '{}'); }
                catch (e) { return sendJson(res, 400, { error: 'invalid JSON body' }); }
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

                const results = [];
                installable.forEach((s) => {
                    const token = newDownloadToken(s.id);
                    const url = baseUrl + '/pluginadmin.ashx?pin=softctl&action=download&token=' + token;
                    // Échappe pour insertion littérale dans la chaîne PS.
                    const psEscape = (v) => String(v || '').replace(/'/g, "''");
                    const ps = [
                        "$ErrorActionPreference = 'Stop'",
                        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
                        "try { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true } } catch {}",
                        "$url = '" + psEscape(url) + "'",
                        "$installer = '" + psEscape(s.installer) + "'",
                        "$silentArgs = '" + psEscape(s.silentArgs) + "'",
                        "$archiveInstaller = '" + psEscape(s.archiveInstaller || '') + "'",
                        "$tmpDir = Join-Path $env:TEMP ('softctl_' + [System.Guid]::NewGuid().ToString('N'))",
                        "New-Item -Path $tmpDir -ItemType Directory -Force | Out-Null",
                        "$download = Join-Path $tmpDir $installer",
                        "Write-Output \"softctl: download $url -> $download\"",
                        "Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing",
                        "$ext = [System.IO.Path]::GetExtension($installer).ToLower()",
                        "if ($ext -eq '.zip') {",
                        "  if (-not $archiveInstaller) { Write-Output 'softctl: ERROR archive sans archiveInstaller'; Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue; exit 2 }",
                        "  $extractDir = Join-Path $tmpDir 'extract'",
                        "  Write-Output \"softctl: extract -> $extractDir\"",
                        "  Expand-Archive -Path $download -DestinationPath $extractDir -Force",
                        "  $target = Join-Path $extractDir $archiveInstaller",
                        "  if (-not (Test-Path $target)) { Write-Output \"softctl: ERROR installeur non trouvé dans l'archive: $archiveInstaller\"; Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue; exit 3 }",
                        "  $tExt = [System.IO.Path]::GetExtension($target).ToLower()",
                        "  if ($tExt -eq '.msi') {",
                        "    $msiArgs = \"/i `\"$target`\" \" + $silentArgs",
                        "    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -PassThru -Wait",
                        "  } else {",
                        "    if ($silentArgs) { $proc = Start-Process -FilePath $target -ArgumentList $silentArgs -PassThru -Wait -WorkingDirectory (Split-Path $target) }",
                        "    else { $proc = Start-Process -FilePath $target -PassThru -Wait -WorkingDirectory (Split-Path $target) }",
                        "  }",
                        "} elseif ($ext -eq '.msi') {",
                        "  $msiArgs = \"/i `\"$download`\" \" + $silentArgs",
                        "  $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -PassThru -Wait",
                        "} else {",
                        "  if ($silentArgs) { $proc = Start-Process -FilePath $download -ArgumentList $silentArgs -PassThru -Wait }",
                        "  else { $proc = Start-Process -FilePath $download -PassThru -Wait }",
                        "}",
                        "Write-Output \"softctl: exit code $($proc.ExitCode)\"",
                        "Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue",
                    ].join('\r\n');

                    nodeIds.forEach((nodeId) => {
                        const ws = wsagents[nodeId];
                        if (!ws || typeof ws.send !== 'function') {
                            results.push({ softId: s.id, nodeId: nodeId, ok: false, error: 'agent déconnecté' });
                            return;
                        }
                        try {
                            ws.send(JSON.stringify({
                                action: 'runcommands',
                                type: 2,         // 2 = PowerShell
                                cmds: ps,
                                runAsUser: 0,    // 0 = LocalSystem
                                reply: false,
                            }));
                            results.push({ softId: s.id, nodeId: nodeId, ok: true });
                        } catch (e) {
                            results.push({ softId: s.id, nodeId: nodeId, ok: false, error: e.message });
                        }
                    });
                });

                const ok = results.filter((r) => r.ok).length;
                const fail = results.length - ok;
                sendJson(res, 200, {
                    dispatched: ok,
                    failed: fail,
                    total: results.length,
                    note: ok + ' commande(s) envoyée(s), ' + fail + ' échec(s) au dispatch. Le résultat d\'installation côté poste apparaît dans l\'onglet "Console" du poste dans MeshCentral.',
                    results: results.slice(0, 50),
                });
            });
            return;
        }

        if (action === 'dryRun') {
            // For now we just echo what we'd push, so the UI can show a preview.
            // Phase 3 will replace this with the real agent dispatch.
            let body = '';
            req.on('data', (c) => { body += c.toString('utf8'); });
            req.on('end', () => {
                let payload;
                try { payload = JSON.parse(body || '{}'); }
                catch (e) { return sendJson(res, 400, { error: 'invalid JSON body' }); }
                const softIds = Array.isArray(payload.softIds) ? payload.softIds : [];
                const nodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds : [];
                const cat = listCatalog();
                const picked = cat.softwares.filter((s) => softIds.indexOf(s.id) !== -1);
                sendJson(res, 200, {
                    plan: picked.map((s) => ({
                        software: s.name + (s.version ? ' ' + s.version : ''),
                        installer: s.installer,
                        silentArgs: s.silentArgs,
                        nodes: nodeIds.length,
                    })),
                    note: 'Phase 1: dry-run only. Aucune commande envoyée aux agents.',
                });
            });
            return;
        }

        // Default (no action): render the plugin's handlebars view.
        res.render(path.join(__dirname, 'views/softctl'), { user: user });
    };

    return obj;
};
