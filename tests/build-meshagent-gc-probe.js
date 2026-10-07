'use strict';

// Produit un test pour le véritable runtime MeshAgent (les mocks Node gardent
// eux-mêmes des références et ne peuvent pas reproduire sa collecte mémoire).
// node tests/build-meshagent-gc-probe.js [source-agent.js] > probe.js
// Sur Windows : MeshAgent.exe "C:\chemin\probe.js"
// Exécuter ce fichier dans un processus de test séparé, jamais via eval dans
// l'agent de service : il force une collecte et termine son propre processus.
// Aucune installation : le seul batch attend deux secondes puis renvoie 23.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../modules_meshcore/softctl.js'), 'utf8');
const start = source.indexOf('function readAgentTextFile(');
const end = source.indexOf('function runInstaller(');
if (start < 0 || end < start) throw new Error('Fonctions du lanceur introuvables');

process.stdout.write('var activeWindowsBatches = {};\n' + source.slice(start, end) + String.raw`
var fs = require('fs');
var probePath = process.env.TEMP + '\\softctl_gc_probe_' + Date.now() + '.bat';
var result = { callbacks: 0 };
fs.writeFileSync(probePath, '@echo off\r\nping -n 3 127.0.0.1 >nul\r\n'
    + '> "' + probePath + '.exit" echo SOFTCTL_EXIT=23\r\nexit /b 23\r\n');
runWindowsBatch(probePath, 5000, function () {}, function (code, err) {
    result.callbacks++;
    result.exit = code;
    result.error = err;
});
// Ces deux timers appartiennent au script principal et restent accessibles.
var collectTimer = setTimeout(function () {
    collectTimer = null;
    Duktape.gc();
    Duktape.gc();
}, 200);
var finishTimer = setTimeout(function () {
    result.activeBatches = Object.keys(activeWindowsBatches).length;
    result.statusExists = fs.existsSync(probePath + '.exit');
    console.log(JSON.stringify(result));
    try { fs.unlinkSync(probePath); } catch (_) {}
    try { fs.unlinkSync(probePath + '.exit'); } catch (_) {}
    process.exit(result.callbacks === 1 && result.exit === 23 && !result.error
        && result.activeBatches === 0 && !result.statusExists ? 0 : 1);
}, 4000);
`);
