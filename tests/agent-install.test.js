'use strict';

// Tests de la chaîne de déploiement, sans exécuter de logiciel ni contacter un
// agent. Les doubles modélisent les différences MeshAgent / Node.js utilisées
// ici : argv Windows brut, fs sans encoding, exit différé par les pipes en pause.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(process.env.SOFTCTL_AGENT_SOURCE || path.join(__dirname, '../modules_meshcore/softctl.js'), 'utf8');

function harness(options = {}) {
    const files = new Map();
    const timers = new Map();
    const children = [];
    const replies = [];
    const removed = [];
    let timerId = 0;
    const fakeFs = {
        mkdirSync() {},
        writeFileSync(filename, data) {
            files.set(filename, data);
            if (options.staleStatus && filename.endsWith('.bat')) {
                files.set(filename + '.exit', 'SOFTCTL_EXIT=0\r\n');
                files.set(filename + '.exit.tmp', 'SOFTCTL_EXIT=0\r\n');
            }
        },
        existsSync(filename) { return files.has(filename); },
        readFileSync(filename) {
            assert.equal(arguments.length, 1, 'MeshAgent fs.readFileSync ne prend pas encoding');
            if (!files.has(filename)) throw new Error('ENOENT: ' + filename);
            return Buffer.from(files.get(filename));
        },
        unlinkSync(filename) {
            if (options.lockedStatus && filename.endsWith('.exit')) throw new Error('EACCES');
            files.delete(filename);
        },
    };
    const fakeCp = {
        execFile(exe, argv) {
            if (options.spawnError) throw new Error(options.spawnError);
            const child = new EventEmitter();
            child.exe = exe;
            child.argv = Array.from(argv);
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = { end() { child.inputClosed = true; } };
            child.killCount = 0;
            child.kill = () => { child.killCount++; child.emit('exit', 0); };
            // Aucun exitCode : l'API MeshAgent ne garantit pas cette propriété.
            child.complete = (code, stdout = '', stderr = '') => {
                // Le runtime garde exit en attente s'il reste des données non lues.
                if ((stdout && !child.stdout.listenerCount('data')) || (stderr && !child.stderr.listenerCount('data'))) return;
                if (stdout) child.stdout.emit('data', Buffer.from(stdout));
                if (stderr) child.stderr.emit('data', Buffer.from(stderr));
                child.emit('exit', code);
            };
            children.push(child);
            return child;
        },
    };
    const context = vm.createContext({
        module: { exports: {} },
        process: { platform: 'win32', env: { TEMP: options.tempRoot || 'C:\\Windows\\Temp Admin', windir: 'C:\\Windows' } },
        require(name) {
            if (name === 'fs') return fakeFs;
            if (name === 'child_process') return fakeCp;
            throw new Error('Unexpected module: ' + name);
        },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) {
            // MeshAgent retire le handle avant d'appeler le callback. Annuler
            // un timer expiré lève une erreur, contrairement à Node.js.
            assert.ok(timers.has(id), 'timers.clearTimeout(): Invalid Parameter');
            timers.delete(id);
        },
    });
    vm.runInContext(source, context);
    context.dbg = () => {};
    context.download = (url, dest, cb) => { files.set(dest, 'fake download'); cb(); };
    context.rmRf = (folder) => { removed.push(folder); };
    function install(overrides = {}) {
        context.module.exports.consoleaction({
            pluginaction: 'install', dispatchId: 'test-job', url: 'https://example.invalid/package',
            installer: 'Package.zip', archiveInstaller: 'bin/Setup.exe', silentArgs: '/quiet', ...overrides,
        }, null, null, { SendCommand(msg) { replies.push(msg); } });
    }
    function extraction() {
        const batPath = [...files.keys()].find((p) => p.endsWith('\\extract.bat'));
        assert.ok(batPath);
        return {
            batPath,
            folder: batPath.slice(0, -'extract.bat'.length),
            logPath: batPath.replace(/\.bat$/, '.log'),
        };
    }
    function timeout(ms) {
        const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
        assert.ok(entry, 'timeout attendu');
        timers.delete(entry[0]);
        entry[1].fn();
    }
    function installerBatch() {
        const filename = [...files.keys()].find((p) => /softctl_run_.*\.bat$/.test(p));
        assert.ok(filename, 'batch de lancement attendu');
        return filename;
    }
    return { files, timers, children, replies, removed, install, extraction, timeout, installerBatch,
        activeBatches: context.activeWindowsBatches };
}

test('MeshAgent ancien : conserve processus et timers depuis le module jusqu’au résultat', () => {
    const h = harness();
    h.install({ installer: 'Setup.exe' });
    const batch = h.installerBatch();
    const active = h.activeBatches[batch];
    assert.equal(active.child, h.children[0]);
    assert.ok(h.timers.has(active.timer));
    assert.ok(h.timers.has(active.pollTimer));
    const previousPoll = active.pollTimer;
    h.timeout(1000);
    assert.notEqual(active.pollTimer, previousPoll);
    assert.ok(h.timers.has(active.pollTimer), 'le nouveau poll reste accessible');
    h.files.set(batch + '.exit', 'SOFTCTL_EXIT=0\r\n');
    h.timeout(1000);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, 0);
    assert.equal(Object.keys(h.activeBatches).length, 0);
    assert.equal(h.timers.size, 0);
});

test('exécutions simultanées : terminer un batch ne libère pas les autres', () => {
    const h = harness();
    h.install({ installer: 'One.exe', dispatchId: 'one' });
    h.install({ installer: 'Two.exe', dispatchId: 'two' });
    assert.equal(Object.keys(h.activeBatches).length, 2);
    h.children[0].complete(0);
    const remaining = Object.values(h.activeBatches);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].child, h.children[1]);
    assert.ok(h.timers.has(remaining[0].timer));
    h.timeout(30 * 60 * 1000);
    assert.equal(Object.keys(h.activeBatches).length, 0);
    assert.equal(h.replies.length, 2);
    assert.equal(h.replies[1].dispatchId, 'two');
    assert.match(h.replies[1].error, /timeout/);
});

test('ZIP : poursuit après extraction même si cmd produit stdout/stderr, puis remonte un seul résultat', () => {
    const h = harness();
    h.install();
    const extraction = h.extraction();
    const target = extraction.folder + 'extract\\bin\\Setup.exe';
    h.files.set(target, 'fake executable');
    h.files.set(extraction.logPath, '');
    h.children[0].complete(0, 'shell stdout\r\n', 'shell stderr\r\n');
    assert.equal(h.children.length, 2, 'lancement après extraction');
    assert.equal(h.children[0].inputClosed, true);
    const runBat = [...h.files.keys()].find((p) => /softctl_run_.*\.bat$/.test(p));
    const script = h.files.get(runBat);
    assert.ok(script.includes('cd /d "' + path.win32.dirname(target) + '"'), 'fichiers annexes résolus depuis le dossier du programme');
    assert.ok(script.includes('"' + target + '" /quiet'));
    h.files.set(runBat.replace(/\.bat$/, '.log'), 'installation terminée\r\n');
    h.children[1].complete(0, 'last output');
    h.children[1].emit('exit', 0);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, 0);
    assert.match(h.replies[0].log, /extract OK/);
    assert.match(h.replies[0].log, /installation terminée/);
    assert.equal(h.removed.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(Object.keys(h.activeBatches).length, 0);
});

test('cmd reçoit argv[0] et un chemin de batch avec espaces correctement cité', () => {
    const h = harness();
    h.install();
    const child = h.children[0];
    assert.equal(child.exe, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(child.argv, ['cmd.exe', '/d', '/s', '/c', '""' + h.extraction().batPath + '""']);
});

test('erreur extraction : diagnostic lu avec fs MeshAgent et aucun lancement', () => {
    const h = harness();
    h.install();
    const ext = h.extraction();
    h.files.set(ext.logPath, 'Archive end record missing\r\n');
    h.files.set(ext.folder + 'extract\\bin\\Setup.exe', 'partial extraction');
    h.children[0].complete(1);
    assert.equal(h.children.length, 1);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, -1);
    assert.match(h.replies[0].log, /Archive end record missing/);
    assert.equal(h.timers.size, 0);
});

test('extraction réussie mais cible absente : erreur explicite sans lancement', () => {
    const h = harness();
    h.install();
    h.children[0].complete(0);
    assert.equal(h.children.length, 1);
    assert.match(h.replies[0].error, /cible introuvable/);
});

test('timeout extraction : kill synchrone et exit tardif ne lancent jamais la cible', () => {
    const h = harness();
    h.install();
    h.files.set(h.extraction().folder + 'extract\\bin\\Setup.exe', 'partial extraction');
    h.timeout(10 * 60 * 1000);
    h.children[0].emit('exit', 0);
    assert.equal(h.children.length, 1);
    assert.equal(h.children[0].killCount, 1);
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0].error, /timeout/);
    assert.equal(h.removed.length, 1);
    assert.equal(h.timers.size, 0);
});

test('erreur asynchrone du processus : résultat unique et timer annulé', () => {
    const h = harness();
    h.install();
    h.children[0].emit('error', new Error('process failed'));
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0].error, /process failed/);
    assert.equal(h.timers.size, 0);
});

test('échec de création du processus : erreur remontée sans timer restant', () => {
    const h = harness({ spawnError: 'CreateProcess failed' });
    h.install();
    assert.equal(h.replies.length, 1);
    assert.match(h.replies[0].error, /CreateProcess failed/);
    assert.equal(h.timers.size, 0);
    assert.equal(Object.keys(h.activeBatches).length, 0);
});

for (const installer of ['Setup.exe', 'Setup.msi', 'Setup.cmd']) {
    test(installer + ' : lancement direct, journal et code retour conservés', () => {
        const h = harness();
        h.install({ installer });
        assert.equal(h.children.length, 1);
        const runBat = [...h.files.keys()].find((p) => /softctl_run_.*\.bat$/.test(p));
        const script = h.files.get(runBat);
        if (installer.endsWith('.cmd')) assert.match(script, /\r\ncall "/);
        if (installer.endsWith('.msi')) assert.match(script, /msiexec\.exe \/i .* \/quiet/);
        h.files.set(runBat.replace(/\.bat$/, '.log'), 'installer diagnostic');
        h.children[0].complete(1603, 'cmd output');
        assert.equal(h.replies.length, 1);
        assert.equal(h.replies[0].exit, 1603);
        assert.match(h.replies[0].log, /installer diagnostic/);
        assert.equal(h.timers.size, 0);
    });
}

test('MSI sans arguments : options silencieuses par défaut conservées', () => {
    const h = harness();
    h.install({ installer: 'Setup.msi', silentArgs: '' });
    const runBat = [...h.files.keys()].find((p) => /softctl_run_.*\.bat$/.test(p));
    assert.match(h.files.get(runBat), /msiexec\.exe \/i .* \/qn \/norestart/);
});

test('timeout installation : un seul échec même si kill déclenche exit', () => {
    const h = harness();
    h.install({ installer: 'Setup.exe' });
    h.timeout(30 * 60 * 1000);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, -1);
    assert.match(h.replies[0].error, /timeout/);
    assert.equal(h.children[0].killCount, 1);
    assert.equal(h.timers.size, 0);
});

test('PowerShell : erreurs bloquantes et apostrophes du chemin échappées', () => {
    const h = harness({ tempRoot: "C:\\Users\\L'Admin\\Temp" });
    h.install();
    const script = h.files.get(h.extraction().batPath);
    assert.ok(script.includes("$ErrorActionPreference = 'Stop'"));
    assert.ok(script.includes("L''Admin"));
    assert.ok(script.includes('SOFTCTL_EXTRACT_START'));
    assert.ok(script.includes('SOFTCTL_EXTRACT_EXIT=%softctl_extract_exit%'));
    assert.match(script, /set "softctl_extract_exit=%errorlevel%"\r\n/);
    assert.match(script, /exit \/b %softctl_extract_exit%\r\n$/);
});

for (const code of [0, 1603, -1978335189]) {
    test('événement exit absent : récupère le code ' + code + ' sans tuer ni relancer le programme', () => {
        const h = harness();
        h.install({ installer: 'Setup.exe' });
        const batch = h.installerBatch();
        h.files.set(batch.replace(/\.bat$/, '.log'), 'installation output');
        h.files.set(batch + '.exit', 'SOFTCTL_EXIT=' + code + '\r\n');
        h.timeout(1000);
        assert.equal(h.replies.length, 1);
        assert.equal(h.replies[0].exit, code);
        assert.match(h.replies[0].log, /cmd exit recovered from status file/);
        assert.match(h.replies[0].log, /installation output/);
        assert.equal(h.children.length, 1);
        assert.equal(h.children[0].killCount, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(h.files.has(batch + '.exit'), false);
        h.children[0].emit('exit', code); // L'événement finit par arriver.
        assert.equal(h.replies.length, 1);
        assert.equal(h.removed.length, 1);
    });
}

test('événement exit absent pendant extraction puis installation : chaîne complète', () => {
    const h = harness();
    h.install();
    const extraction = h.extraction();
    h.files.set(extraction.folder + 'extract\\bin\\Setup.exe', 'fake executable');
    h.files.set(extraction.batPath + '.exit', 'SOFTCTL_EXIT=0\r\n');
    h.timeout(1000);
    assert.equal(h.children.length, 2);
    assert.equal(h.replies.length, 0);
    h.children[0].emit('exit', 0); // Ne pas relancer une seconde installation.
    assert.equal(h.children.length, 2);
    h.files.set(h.installerBatch() + '.exit', 'SOFTCTL_EXIT=0\r\n');
    h.timeout(1000);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, 0);
    assert.equal(h.timers.size, 0);
});

test('texte de réussite, fichier temporaire et résultat incomplet ne valident jamais le déploiement', () => {
    const h = harness();
    h.install({ installer: 'Setup.exe' });
    const batch = h.installerBatch();
    h.files.set(batch.replace(/\.bat$/, '.log'), 'Uninstall completed successfully.');
    h.files.set(batch + '.exit.tmp', 'SOFTCTL_EXIT=0\r\n');
    h.timeout(1000);
    assert.equal(h.replies.length, 0);
    for (const invalid of ['', '0\r\n', 'SOFTCTL_EXIT=0', 'SOFTCTL_EXIT=0oops\r\n', 'SOFTCTL_EXIT=0\r\nextra', 'SOFTCTL_EXIT=999999999999999\r\n']) {
        h.files.set(batch + '.exit', invalid);
        h.timeout(1000);
        assert.equal(h.replies.length, 0, 'résultat invalide ignoré : ' + JSON.stringify(invalid));
    }
    h.files.set(batch + '.exit', 'SOFTCTL_EXIT=5\r\n');
    h.timeout(1000);
    assert.equal(h.replies[0].exit, 5, 'le code réel prime sur le texte du logiciel');
    assert.equal(h.timers.size, 0);
});

test('résultat disponible à la dernière seconde : pas de faux timeout', () => {
    const h = harness();
    h.install({ installer: 'Setup.exe' });
    h.files.set(h.installerBatch() + '.exit', 'SOFTCTL_EXIT=0\r\n');
    h.timeout(30 * 60 * 1000);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, 0);
    assert.equal(h.replies[0].error, undefined);
    assert.equal(h.children[0].killCount, 0);
    assert.equal(h.timers.size, 0);
});

test('un ancien résultat est supprimé avant le lancement', () => {
    const h = harness({ staleStatus: true });
    h.install({ installer: 'Setup.exe' });
    const batch = h.installerBatch();
    assert.equal(h.files.has(batch + '.exit'), false);
    assert.equal(h.files.has(batch + '.exit.tmp'), false);
    h.timeout(1000);
    assert.equal(h.replies.length, 0);
    h.children[0].complete(5);
    assert.equal(h.replies[0].exit, 5);
    assert.equal(h.timers.size, 0);
});

test('ancien résultat impossible à supprimer : lancement refusé, aucun faux succès', () => {
    const h = harness({ staleStatus: true, lockedStatus: true });
    h.install({ installer: 'Setup.exe' });
    assert.equal(h.children.length, 0);
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].exit, -1);
    assert.match(h.replies[0].error, /EACCES/);
    assert.equal(h.timers.size, 0);
});
