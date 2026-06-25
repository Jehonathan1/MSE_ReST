// test/engine-trigger.test.js — night-60 regression.
//
// (1) The TEST-ONLY engine driver builds the right Viz Engine command shapes — in
//     particular the cleanup sequence is the ON-SITE-FAITHFUL one (three empty
//     layer unloads + the CACHE CLEANUP block) the night-59 detector keys on, and
//     loads use the FULL `RENDERER*<LAYER>` MSE form (not viz-engine-gui's `REND*`).
// (2) The live Viz 3.14.5 engine echoes commands WRAPPED (`...(TCP): receive <0
//     SCENE CLEANUP>`) — discovered live on night-60, not the bare on-site fixture.
//     The existing classifier still latches exactly ONE clear through the wrapper
//     (the CLEANUP verb is a substring match), a wrapped load does NOT clear, and a
//     wrapped single take-out does NOT over-fire. This locks the live format in.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildCommands, CLEANUP_SEQUENCE } = require('../scripts/engine-trigger');
const { EngineConsoleAdapter } = require('../src/recorder/adapters');

const opts = (..._) => ({ _ });
const FIX_WRAPPED = path.join(__dirname, 'fixtures', 'engine-cleanup.wrapped.console.txt');
const FIX_BARE = path.join(__dirname, 'fixtures', 'engine-cleanup.console.txt');

// ---- (1) driver command shapes --------------------------------------------

test('driver cleanup = the on-site-faithful sequence (3 layer unloads + CACHE CLEANUP block)', () => {
  assert.deepStrictEqual(buildCommands('cleanup', opts('cleanup')), [
    'RENDERER*FRONT_LAYER SET_OBJECT',
    'RENDERER*MAIN_LAYER SET_OBJECT',
    'RENDERER*BACK_LAYER SET_OBJECT',
    'SCENE CLEANUP', 'GEOM CLEANUP', 'IMAGE CLEANUP', 'FONT CLEANUP', 'MATERIAL CLEANUP', 'MAPS CACHE CLEANUP',
  ]);
});

test('driver cleanup matches the committed on-site BARE console fixture command lines', () => {
  // The bare fixture is the on-site console; its command lines (not the noise/log
  // lines) must be exactly what the driver replicates.
  const fixtureCmds = fs.readFileSync(FIX_BARE, 'utf8').split(/\r?\n/)
    .filter((l) => /^(RENDERER\*|SCENE |GEOM |IMAGE |FONT |MATERIAL |MAPS )/.test(l.trim()))
    .map((l) => l.trim());
  assert.deepStrictEqual(CLEANUP_SEQUENCE, fixtureCmds);
});

test('driver load uses the FULL RENDERER*<LAYER> form + single leading slash', () => {
  assert.deepStrictEqual(buildCommands('load', opts('load', 'Brand/controller_scenes/BUG_TOP_LEFT')),
    ['RENDERER*MAIN_LAYER SET_OBJECT SCENE*/Brand/controller_scenes/BUG_TOP_LEFT']);
  assert.deepStrictEqual(buildCommands('load', opts('load', '/already/slashed', 'FRONT')),
    ['RENDERER*FRONT_LAYER SET_OBJECT SCENE*/already/slashed']);
});

test('driver unload / take-out emit a single empty SET_OBJECT (one layer)', () => {
  assert.deepStrictEqual(buildCommands('unload', opts('unload')), ['RENDERER*MAIN_LAYER SET_OBJECT']);
  assert.deepStrictEqual(buildCommands('take-out', opts('take-out', 'FRONT')), ['RENDERER*FRONT_LAYER SET_OBJECT']);
});

test('driver probe / list are read-only (no SET/take)', () => {
  for (const cmd of [...buildCommands('probe', opts('probe')), ...buildCommands('list', opts('list'))]) {
    assert.ok(!/SET_OBJECT|CLEANUP/.test(cmd), `read-only command must not mutate: ${cmd}`);
  }
});

// ---- (2) the live WRAPPED console format (night-60 discovery) ---------------

test('EngineConsoleAdapter latches exactly one clear from the live WRAPPED cleanup console', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (i) => clears.push(i));
  a.ingestConsoleLines(fs.readFileSync(FIX_WRAPPED, 'utf8'));
  assert.strictEqual(clears.length, 1, 'one clear through the (TCP): receive <...> wrapper');
  assert.match(clears[0].reason, /cleanup/);
});

test('a WRAPPED scene load does NOT clear (classified load); a WRAPPED single take-out does NOT over-fire', () => {
  const a = new EngineConsoleAdapter({ cfg: {}, now: () => 't', log: () => {} });
  const clears = [];
  a.on('clear', (i) => clears.push(i));
  a.ingestConsoleLines('127.0.0.1:6100 (TCP): receive <0 RENDERER*MAIN_LAYER SET_OBJECT SCENE*/Brand/x>\n');
  a.ingestConsoleLines('127.0.0.1:6100 (TCP): receive <0 RENDERER*FRONT_LAYER SET_OBJECT>\n');
  assert.strictEqual(clears.length, 0, 'neither a wrapped load nor a wrapped single take-out is a profile cleanup');
});
