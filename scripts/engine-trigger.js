#!/usr/bin/env node
// scripts/engine-trigger.js — TEST-ONLY Viz Engine command driver (night-60).
//
// PURPOSE.  The night-59 engine-console CLEANUP detector
// (src/recorder/engineConsole.js + adapters/engineConsoleAdapter.js) was built
// and offline-proven, but the live end-to-end (a real cleanup off a real engine
// → the adapter detects it → the recorder clears) was DEFERRED because firing a
// cleanup was a GUI/operator action. This driver removes that dependency: it
// replicates — over raw TCP — the exact Viz Engine commands the **MSE** fires at
// the engine during a profile cleanup, so the take→cleanup→clear loop can be run
// self-driven against the LOCAL dev engine, with no other app and no button.
//
// READ-ONLY POSTURE (the project cardinal rule).  This is a SEPARATE client. It
// writes ONLY to the engine command port (default 127.0.0.1:6100) and it
// HARD-REFUSES any non-loopback host unless `--allow-nonlocal` is passed (which
// the test pipeline never passes). The recorder gains no write path from this —
// the recorder still only SUBSCRIBEs/gets/GETs. Per CLAUDE.md: "Writing to your
// local dev MSE/engine is fine for tests, but do it from a *separate* client, not
// the recorder." This file is that separate client. It never speaks to the MSE
// (8580/8595/8582) or Pilot (8177) — engine TCP only.
//
// COMMAND PROVENANCE (replicated, not invented — see ../viz-engine-gui & on-site):
//   * TCP transport     mirrors viz-engine-gui/server/proxy.js sendVizCommandTCP()
//                       (net.Socket per command, `<cmd>\0` terminator, idle close).
//   * scene load        viz-engine-gui api.js addSceneToPoolByPath():
//                       `0 REND*<LAYER> SET_OBJECT SCENE*/path`. We emit the FULL
//                       `RENDERER*<LAYER>` MSE form (NOT the GUI's `REND*` alias) so
//                       the console echo hits the detector's real parse path.
//   * GH discovery      viz-engine-gui api.js: `0 SCENE GET_ALL_GROUPS` (folders)
//                       and `0 SCENE*<folder> GET` (scenes in a folder).
//   * cleanup           the ON-SITE MSE profile-cleanup shape (night-59 evidence +
//                       test/fixtures/engine-cleanup.console.txt): three empty
//                       `RENDERER*<LAYER> SET_OBJECT` layer unloads (FRONT/MAIN/BACK)
//                       THEN the `SCENE/GEOM/IMAGE/FONT/MATERIAL/MAPS CACHE CLEANUP`
//                       block. NOTE this is the MSE's cleanup, NOT viz-engine-gui's
//                       runCleanupSequence() (which adds VIZ_COMMUNICATION*MAP CLEAR
//                       + POOLS CLEANUP and omits the layer unloads) — we replicate
//                       what the MSE actually does so the recorder sees its real path.
//
// The mcr-controller profile cleanup (`POST /profiles/<p>/cleanup`, rel="cleanup")
// is the production/on-site path; it is an HTTP POST against the MSE (perms-denied)
// and needs a profile the bare local rig lacks, so it is NOT built here. Engine-
// direct TCP is the home path that produces the same engine-side console signature.

'use strict';

const net = require('net');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { host: '127.0.0.1', port: 6100, verbose: false, dryRun: false,
              allowNonlocal: false, jsonOut: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') o.host = argv[++i];
    else if (a === '--port') o.port = parseInt(argv[++i], 10);
    else if (a === '--json-out') o.jsonOut = argv[++i];
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--allow-nonlocal') o.allowNonlocal = true;
    else o._.push(a);
  }
  return o;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
function assertLocal(opts) {
  if (LOOPBACK.has(String(opts.host)) || opts.allowNonlocal) return;
  console.error(`\nREFUSING to run against non-loopback host "${opts.host}".`);
  console.error('This is a TEST-ONLY driver and must stay read-only toward production.');
  console.error('If you really mean a non-local engine, pass --allow-nonlocal (you almost never should).\n');
  process.exit(2);
}

// Layer token: accept MAIN / FRONT / BACK (or the full *_LAYER) → RENDERER*<X>_LAYER.
function layerToken(name, dflt = 'MAIN') {
  let s = String(name || dflt).trim().toUpperCase();
  if (!s.endsWith('_LAYER')) s = s + '_LAYER';
  return s; // FRONT_LAYER | MAIN_LAYER | BACK_LAYER (or any *_LAYER the caller named)
}

function normScenePath(p) {
  return '/' + String(p).replace(/^\/+/, ''); // exactly one leading slash, like the GUI
}

// ---------------------------------------------------------------------------
// TCP send — mirrors viz-engine-gui proxy.js sendVizCommandTCP()
// ---------------------------------------------------------------------------
function sendCommand(opts, command, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let response = '';
    let dataTimeout;
    let connected = false;
    const startTime = Date.now();

    const connectTimeout = setTimeout(() => {
      if (!connected) { client.destroy(); reject(new Error(`connect timeout ${opts.host}:${opts.port}`)); }
    }, 3000);

    client.connect(opts.port, opts.host, () => {
      connected = true;
      clearTimeout(connectTimeout);
      client.write(command + '\0');             // viz-id-prefixed command, NUL-terminated
    });
    client.on('data', (data) => {
      response += data.toString();
      clearTimeout(dataTimeout);
      dataTimeout = setTimeout(() => client.destroy(), 500); // idle close, like the GUI
    });
    client.on('close', () => {
      clearTimeout(dataTimeout); clearTimeout(connectTimeout);
      resolve({ command, response, ms: Date.now() - startTime });
    });
    client.on('error', (err) => {
      clearTimeout(dataTimeout); clearTimeout(connectTimeout);
      reject(err);
    });
    setTimeout(() => { client.destroy(); if (!response) reject(new Error('command timeout - no response')); }, timeout);
  });
}

// Run a list of raw command strings sequentially (one connection each, like the
// GUI's runCleanupSequence). Each gets the `0 ` viz-id prefix the TCP API needs.
async function runSequence(opts, rawCommands, sink) {
  for (const raw of rawCommands) {
    const wire = `0 ${raw}`;
    if (opts.dryRun) {
      console.log(`DRY  -> ${wire}`);
      sink.push({ command: wire, response: '(dry-run)', ms: 0, ts: new Date().toISOString() });
      continue;
    }
    try {
      const r = await sendCommand(opts, wire);
      const oneLine = String(r.response).replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
      console.log(`SENT -> ${wire}`);
      if (opts.verbose) console.log(`     <- (${r.ms}ms) ${oneLine || '(empty)'}`);
      sink.push({ command: wire, response: r.response, ms: r.ms, ts: new Date().toISOString() });
    } catch (err) {
      console.error(`FAIL -> ${wire} : ${err.message}`);
      sink.push({ command: wire, error: err.message, ts: new Date().toISOString() });
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand command-builders (return the raw command list; `0 ` added by runner)
// ---------------------------------------------------------------------------

// On-site-faithful profile cleanup: 3 empty layer unloads THEN the CLEANUP block.
// Matches test/fixtures/engine-cleanup.console.txt lines 3-11 exactly.
const CLEANUP_SEQUENCE = [
  'RENDERER*FRONT_LAYER SET_OBJECT',
  'RENDERER*MAIN_LAYER SET_OBJECT',
  'RENDERER*BACK_LAYER SET_OBJECT',
  'SCENE CLEANUP',
  'GEOM CLEANUP',
  'IMAGE CLEANUP',
  'FONT CLEANUP',
  'MATERIAL CLEANUP',
  'MAPS CACHE CLEANUP',
];

function onOff(v, dflt = 'ON') {
  const s = String(v || dflt).trim().toUpperCase();
  return (s === 'OFF' || s === '0' || s === 'FALSE') ? 'OFF' : 'ON';
}

function buildCommands(sub, opts) {
  const a = opts._.slice(1); // args after the subcommand
  switch (sub) {
    case 'probe':            // READ-ONLY: engine liveness + version (no SET/take).
      return ['VERSION GET', 'IS_ON_AIR GET'];
    // ---- RIG SETUP (local dev engine only) -------------------------------
    // The on-site broadcast engine runs with command-echo ON and in external/
    // on-air control mode, which is WHY the on-site console shows the cleanup
    // command lines the night-59 detector keys on. A bare local dev engine has
    // both OFF by default, so we set them to reproduce the on-site console state.
    // (Viz External Commands Manual: `MAIN SHOW_COMMANDS ON`, `MAIN SWITCH_EXTERNAL ON`.)
    case 'show-commands':    // MAIN SHOW_COMMANDS ON|OFF — echo received commands to console.
      return [`MAIN SHOW_COMMANDS ${onOff(a[0])}`];
    case 'external':         // MAIN SWITCH_EXTERNAL ON|OFF — external/on-air control mode.
      return [`MAIN SWITCH_EXTERNAL ${onOff(a[0])}`];
    case 'list': {           // READ-ONLY: GH discovery.
      const folder = a[0];
      return folder ? [`SCENE*${folder} GET`] : ['SCENE GET_ALL_GROUPS'];
    }
    case 'load': {           // load a scene to a layer → a TAKE/load on the console.
      if (!a[0]) throw new Error('load needs <scenePath> [layer]');
      return [`RENDERER*${layerToken(a[1])} SET_OBJECT SCENE*${normScenePath(a[0])}`];
    }
    case 'unload':           // empty SET_OBJECT on one layer → a single-layer unload.
      return [`RENDERER*${layerToken(a[0])} SET_OBJECT`];
    case 'take-out': {       // a normal per-element take-out: ONE empty SET_OBJECT.
      if (!a[0]) throw new Error('take-out needs <layer> (FRONT|MAIN|BACK)');
      return [`RENDERER*${layerToken(a[0])} SET_OBJECT`];
    }
    case 'cleanup':          // the full on-site-faithful profile cleanup.
      return CLEANUP_SEQUENCE.slice();
    default:
      throw new Error(`unknown subcommand "${sub}"`);
  }
}

const READONLY_SUBS = new Set(['probe', 'list']);

// ---------------------------------------------------------------------------
function usage() {
  console.log(`engine-trigger.js — TEST-ONLY Viz Engine TCP driver (local engine only)

  node scripts/engine-trigger.js <subcommand> [args] [--host H] [--port P] [-v] [--dry-run] [--json-out FILE]

Subcommands:
  probe                       READ-ONLY engine liveness + version + on-air state
  list [folder]               READ-ONLY GH discovery (GET_ALL_GROUPS / SCENE*<folder> GET)
  show-commands <on|off>      RIG SETUP: MAIN SHOW_COMMANDS — echo received commands to console
  external <on|off>           RIG SETUP: MAIN SWITCH_EXTERNAL — external/on-air control mode
  load <scenePath> [layer]    load a scene  -> RENDERER*<LAYER> SET_OBJECT SCENE*/path   (layer default MAIN)
  unload [layer]              unload a layer -> RENDERER*<LAYER> SET_OBJECT (empty)       (layer default MAIN)
  take-out <layer>            single-layer take-out (one empty SET_OBJECT) — must NOT over-fire the detector
  cleanup                     on-site-faithful profile cleanup (3 layer unloads + CLEANUP block)

Defaults to 127.0.0.1:6100. Non-loopback hosts are refused (--allow-nonlocal to override).`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sub = opts._[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { usage(); process.exit(sub ? 0 : 2); }

  assertLocal(opts);

  let commands;
  try { commands = buildCommands(sub, opts); }
  catch (e) { console.error(`error: ${e.message}\n`); usage(); process.exit(2); }

  const tag = READONLY_SUBS.has(sub) ? 'READ-ONLY' : 'ENGINE-WRITE (local test engine)';
  console.log(`[engine-trigger] ${sub} -> ${opts.host}:${opts.port}  [${tag}]${opts.dryRun ? '  (dry-run)' : ''}`);

  const sink = [];
  await runSequence(opts, commands, sink);

  if (opts.jsonOut) {
    const fs = require('fs');
    fs.writeFileSync(opts.jsonOut, JSON.stringify({ subcommand: sub, host: opts.host, port: opts.port,
      at: new Date().toISOString(), sent: sink }, null, 2));
    console.log(`[engine-trigger] wrote ${sink.length} command record(s) -> ${opts.jsonOut}`);
  }

  // For the read-only discovery subcommands, surface a parsed SCENE* list.
  if (sub === 'list' && !opts.dryRun) {
    const scenes = [];
    for (const r of sink) {
      for (const p of String(r.response || '').split(/\s+/)) if (p.startsWith('SCENE*')) scenes.push(p.slice(6));
    }
    console.log(`[engine-trigger] discovered ${scenes.length} SCENE entr(y/ies):`);
    for (const s of scenes.slice(0, 50)) console.log(`   ${s}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[engine-trigger] fatal:', e.message); process.exit(1); });
}

// Exported for the regression test (pure command-builders; no socket).
module.exports = { buildCommands, CLEANUP_SEQUENCE, layerToken, normScenePath, onOff, parseArgs };
