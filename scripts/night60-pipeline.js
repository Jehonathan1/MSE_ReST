#!/usr/bin/env node
// scripts/night60-pipeline.js — TEST-ONLY self-run of the take→cleanup→clear loop.
//
// Drives the REAL Recorder with the REAL EngineConsoleAdapter attached to the live
// local engine (6100), and fires the engine-trigger driver as a SEPARATE process,
// to prove LIVE the thing night-59 deferred: a real profile-cleanup off the real
// engine is detected on the engine console and fanned out to off-air, while a
// scene load does NOT false-clear and a single-layer take-out does NOT over-fire.
//
// WHAT IS REAL vs SEEDED (be honest):
//   * REAL (the night-60 deliverable): the engine-console DETECTION leg — a real
//     engine, a real CONSOLE REDIRECT + file tail, the real EngineConsoleAdapter
//     classifying real console lines from a real cleanup the driver fired, and the
//     core fanning a real off-air out over the on-air map.
//   * SEEDED (work-only on the bare rig): the MSE *take*. A live MSE take + Pilot
//     content are work-only (LOCAL-MSE-SURVEY), so the actor/STOMP legs are stubbed
//     and the on-air element is injected via the recorder's normalized take path
//     (rec._onTakeSignal) with stubbed Pilot content — exactly as the offline tests
//     seed a take. The MSE-take + MSE-faithful-cleanup remain the on-site confirm.
//
// READ-ONLY: the recorder only REDIRECT/FLUSH/reads the console; the driver is the
// only writer and only to the LOCAL engine. No MSE/Pilot write, no POST.

'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resolveConfig } = require('../src/recorder/recorderConfig');
const { Recorder } = require('../src/recorder/recorder');

const DRIVER = path.join(__dirname, 'engine-trigger.js');
const EVID = path.join(__dirname, '..', 'test', 'fixtures', 'live', 'night60');
const REC_DIR = path.join(__dirname, '..', 'recordings');
const CONSOLE_FILE = path.join(REC_DIR, 'night60-pipeline-console.log');
const JSONL = path.join(EVID, 'recorder.jsonl');
const SCENE = 'Brand/controller_scenes/BUG_TOP_LEFT';

fs.mkdirSync(EVID, { recursive: true });
fs.mkdirSync(REC_DIR, { recursive: true });
for (const f of [CONSOLE_FILE, JSONL]) { try { fs.writeFileSync(f, ''); } catch (e) {} }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function drive(label, args) {
  console.log(`\n--- driver: ${label} ---`);
  try { execFileSync('node', [DRIVER, ...args], { stdio: 'inherit' }); }
  catch (e) { console.log(`(driver ${label} exit ${e.status})`); }
}

// A monotonic, collision-free clock so replay sees strictly increasing ts.
let tick = 0;
const now = () => new Date(Date.UTC(2026, 5, 25, 19, 0, 0) + (tick++) * 1000).toISOString();

const cfg = resolveConfig([
  '--mse-host', '127.0.0.1', '--source', 'director',
  '--engine-console', '--engine-host', '127.0.0.1', '--engine-port', '6100',
  '--engine-console-file', CONSOLE_FILE, '--engine-console-poll', '400',
  '--stripe-template', '16097', '--line2-field', '1', '--no-content-poll',
]);

const rec = new Recorder(cfg, { logger: (m) => console.log(m), now, outPath: JSONL });
// SEEDED legs: stub the MSE transports (a real take is work-only on the bare rig).
rec._connectActor = () => console.log('[harness] actor leg STUBBED (seeded take; real MSE take is work-only)');
rec._connectStomp = () => {};
// Stub Pilot content (Pilot is down locally) — a seeded Hebrew stripe.
rec._fetchContent = async (id) => ({
  content: { elementId: id, templateId: '16097', templateName: 'STRIPE',
    fields: { '0': 'ראש הממשלה', '1': 'נואם בכנסת' }, texts: ['ראש הממשלה', 'נואם בכנסת'] },
  pending: false, error: null, raw: '<seeded/>',
});

const offCount = () => readJsonl().filter((e) => e.type === 'off-air').length;
function readJsonl() {
  try { return fs.readFileSync(JSONL, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { return []; }
}

(async () => {
  // ---- engine rig setup (local dev engine only): on-site runs with echo on &
  // on-air; reproduce that state so the cleanup commands execute & echo. -------
  drive('rig: SHOW_COMMANDS ON', ['show-commands', 'ON']);
  drive('rig: SWITCH_EXTERNAL ON (on-air)', ['external', 'ON']);

  rec.start();                 // engine adapter attaches LIVE (REDIRECT + tail)
  await sleep(2800);           // warmup: drain any console backlog (map empty -> harmless)

  // ---- baseline: idle => no false signals ----------------------------------
  check('baseline: no off-air before any take', offCount() === 0);

  // ---- instance 1: take -> LOAD (no false clear) -> CLEANUP (one clear) -----
  await rec._onTakeSignal({ elementId: '20001', templateId: '16097' }, 'director');
  check('take 20001 on air', rec.onAir.has('20001'));
  const baseOff = offCount();

  drive('LOAD scene (must NOT clear)', ['load', SCENE, 'MAIN', '--json-out', path.join(EVID, 'driver.load.json')]);
  await sleep(1800);
  check('load = NO false clear (stripe still on air)', rec.onAir.has('20001') && offCount() === baseOff,
    `onAir=${rec.onAir.has('20001')} offAdded=${offCount() - baseOff}`);

  drive('CLEANUP (on-site-faithful)', ['cleanup', '--json-out', path.join(EVID, 'driver.cleanup.json')]);
  await sleep(2200);
  const off1 = readJsonl().filter((e) => e.type === 'off-air');
  check('cleanup -> exactly one new off-air', off1.length === baseOff + 1, `total off-air=${off1.length}`);
  check('cleanup off-air is engine-sourced & is the stripe', off1.some((e) => e.source === 'engine' && e.elementId === '20001'));
  check('cleanup cleared the on-air map', !rec.onAir.has('20001'));

  // ---- instance 2: take -> single-layer TAKE-OUT (must NOT over-fire) -------
  await rec._onTakeSignal({ elementId: '20002', templateId: '16097' }, 'director');
  const beforeTO = offCount();
  drive('single-layer TAKE-OUT (must NOT over-fire)', ['take-out', 'FRONT', '--json-out', path.join(EVID, 'driver.takeout.json')]);
  await sleep(1800);
  check('single take-out = NO global console clear (20002 still on air)', rec.onAir.has('20002') && offCount() === beforeTO,
    `onAir=${rec.onAir.has('20002')} offAdded=${offCount() - beforeTO}`);
  // close 20002 via the existing per-element director path (proves it still clears)
  rec._markOffAir('20002', 'director');
  check('per-element take-out still clears the map (20002 off via director)', !rec.onAir.has('20002'));

  // ---- instance 3: a plain per-element take-out (director off-air) ----------
  await rec._onTakeSignal({ elementId: '20003', templateId: '16097' }, 'director');
  rec._markOffAir('20003', 'director');
  check('per-element off-air 20003 cleared the map (director)', !rec.onAir.has('20003'));

  await rec.stop();            // closes + FLUSHES the buffered JSONL writer
  await sleep(300);

  // ---- file-based assertions on the FINAL, flushed JSONL --------------------
  const fin = readJsonl();
  const offs = fin.filter((e) => e.type === 'off-air');
  check('JSONL: exactly 3 off-airs recorded', offs.length === 3, `got ${offs.length}`);
  check('JSONL: the cleanup off-air (20001) is engine-sourced',
    offs.some((e) => e.elementId === '20001' && e.source === 'engine'));
  check('JSONL: per-element off-airs (20002,20003) are director-sourced',
    ['20002', '20003'].every((id) => offs.some((e) => e.elementId === id && e.source === 'director')));
  check('JSONL: clean session start+stop bracket',
    fin[0] && fin[0].type === 'session' && fin[0].event === 'start'
    && fin[fin.length - 1].type === 'session' && fin[fin.length - 1].event === 'stop');

  // ---- archive the engine-console excerpt (the real captured lines) ---------
  try {
    const raw = fs.readFileSync(CONSOLE_FILE, 'utf8').split(/\r?\n/);
    const keep = raw.filter((l) => /SET_OBJECT|CLEANUP|Loading|Texture .*(defined|removed)|SWITCH_EXTERNAL|receive <0 (RENDERER|SCENE|GEOM|IMAGE|FONT|MATERIAL|MAPS)/.test(l));
    fs.writeFileSync(path.join(EVID, 'engine-console.excerpt.txt'), keep.join('\n') + '\n');
  } catch (e) { console.log('(could not archive console excerpt)', e.message); }

  // ---- restore engine state (leave the dev engine as we found it) ----------
  drive('rig restore: SWITCH_EXTERNAL OFF', ['external', 'OFF']);
  drive('rig restore: SHOW_COMMANDS OFF', ['show-commands', 'OFF']);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[pipeline] ${passed}/${results.length} checks passed`);
  console.log(`[pipeline] JSONL -> ${JSONL}`);
  fs.writeFileSync(path.join(EVID, 'pipeline-checks.json'), JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
