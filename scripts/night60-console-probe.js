#!/usr/bin/env node
// scripts/night60-console-probe.js — TEST-ONLY transport de-risk for night-60.
//
// Drives the REAL EngineConsoleAdapter against the live local engine (6100) and
// fires the engine-trigger driver as a SEPARATE process, to answer the question
// night-59 deferred: does `CONSOLE REDIRECT` capture the engine's command echoes
// to a readable file, is a *successful* SET_OBJECT load echoed, and does the
// adapter latch exactly one `clear` on the cleanup block (and NOT on a single
// take-out)? Read-only toward playout: the adapter only REDIRECTs/FLUSHes/reads;
// the driver is the only writer, and only to the LOCAL engine.

'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { EngineConsoleAdapter } = require('../src/recorder/adapters/engineConsoleAdapter');

const DRIVER = path.join(__dirname, 'engine-trigger.js');
const CONSOLE_FILE = path.join(__dirname, '..', 'recordings', 'night60-probe-console.log');
const SCENE = 'Brand/controller_scenes/BUG_TOP_LEFT';

try { fs.mkdirSync(path.dirname(CONSOLE_FILE), { recursive: true }); } catch (e) {}
try { fs.writeFileSync(CONSOLE_FILE, ''); } catch (e) {}

const clears = [];
const adapter = new EngineConsoleAdapter({
  cfg: { engineHost: '127.0.0.1', enginePort: 6100, engineConsoleFile: CONSOLE_FILE, engineConsolePollMs: 400 },
  log: (m) => console.log(m),
});
adapter.on('clear', (info) => { clears.push({ at: new Date().toISOString(), info }); console.log('>>> CLEAR EVENT', JSON.stringify(info)); });

function drive(label, args) {
  console.log(`\n--- driver: ${label} -> ${args.join(' ')} ---`);
  try { execFileSync('node', [DRIVER, ...args], { stdio: 'inherit' }); }
  catch (e) { console.log(`(driver ${label} exit ${e.status})`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  adapter.attachEngine();
  await sleep(2000); // let CONSOLE REDIRECT land + offset seed to EOF

  drive('LOAD', ['load', SCENE, 'MAIN']);
  await sleep(2000);
  const afterLoad = clears.length;
  console.log(`[probe] clears after LOAD = ${afterLoad} (expect 0 — a load must not clear)`);

  drive('CLEANUP', ['cleanup']);
  await sleep(2500);
  const afterCleanup = clears.length;
  console.log(`[probe] clears after CLEANUP = ${afterCleanup} (expect ${afterLoad + 1} — exactly one)`);

  drive('TAKE-OUT (single layer)', ['take-out', 'FRONT']);
  await sleep(2000);
  const afterTakeout = clears.length;
  console.log(`[probe] clears after single TAKE-OUT = ${afterTakeout} (expect ${afterCleanup} — no over-fire)`);

  adapter.stop();
  console.log('\n===== CONSOLE FILE (what CONSOLE REDIRECT captured) =====');
  try { console.log(fs.readFileSync(CONSOLE_FILE, 'utf8') || '(empty)'); }
  catch (e) { console.log('(could not read console file)', e.message); }
  console.log('===== END CONSOLE FILE =====');

  const ok = afterLoad === 0 && afterCleanup === afterLoad + 1 && afterTakeout === afterCleanup;
  console.log(`\n[probe] VERDICT: ${ok ? 'PASS' : 'CHECK'} — load=${afterLoad} cleanup=${afterCleanup} takeout=${afterTakeout}`);
  process.exit(0);
})();
