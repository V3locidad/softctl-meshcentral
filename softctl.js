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
            // first .exe/.msi in the folder. Keep filename only (no leading path)
            // so the UI doesn't leak the local mount path.
            let installer = meta.installer || '';
            if (!installer) {
                const files = fs.readdirSync(folder).filter((f) => /\.(exe|msi)$/i.test(f));
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
            });
        }
        out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
        return { softwares: out, skipped: skipped };
    }

    // List the MeshCentral agents (nodes). We read directly from the MC database
    // since obj.meshServer.db.GetAllType('node', cb) is supported by both NeDB
    // and MongoDB backends.
    function listAgents(cb) {
        const db = obj.meshServer && obj.meshServer.db;
        if (!db || typeof db.GetAllType !== 'function') return cb(new Error('MC DB inaccessible'));
        db.GetAllType('node', function (err, docs) {
            if (err) return cb(err);
            const agents = (docs || []).filter((d) => d && d._id && (d.agent || d.osdesc)).map((d) => ({
                id: d._id,
                name: d.name || d.host || d._id,
                meshid: d.meshid || '',
                os: (d.agent && d.agent.id) || d.osdesc || '',
                lastConnect: d.lastConnectTime || 0,
            }));
            agents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true }));
            cb(null, agents);
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
            listAgents(function (err, agents) {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { agents: agents });
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
                if (!filename || !/\.(exe|msi)$/i.test(filename)) return sendJson(res, 400, { error: 'filename .exe ou .msi requis' });
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
                    ['name', 'version', 'vendor', 'silentArgs', 'installer'].forEach((k) => {
                        if (patch[k] !== undefined) current[k] = String(patch[k]).trim();
                    });
                    fs.writeFileSync(metaPath, JSON.stringify(current, null, 2));
                    sendJson(res, 200, { ok: true, software: current });
                } catch (e) { sendJson(res, 500, { error: e.message }); }
            });
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
