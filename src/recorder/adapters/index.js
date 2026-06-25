// src/recorder/adapters/index.js
//
// The detection-adapter interface + factory. An adapter takes the live
// connection(s) the core owns and emits the recorder's normalized detection
// events — `take` / `off-air` (and Trio's `state` snapshot) — each tagged with
// the adapter's `source`. The core does the Pilot join, variant/exclusive
// derivation and JSONL writing; adapters ONLY detect.
//
// The seam (so Stage 2c's Trio work needs zero core changes):
//   - every adapter exposes `source`, `needsActor`, `needsStomp`, `stop()`
//   - actor adapters implement `attachActor(send)` + `handleActorMessage(data)`
//   - stomp adapters implement `attachStomp(subscribe)`
//   - all detection is delivered via EventEmitter 'take' / 'off-air' / 'state'
//
// `--source director|trio|auto` selects which adapters run; auto = both, and the
// core's on-air map de-dupes overlapping take/off-air signals.

const { DirectorAdapter } = require('./directorAdapter');
const { TrioAdapter } = require('./trioAdapter');
const { EngineConsoleAdapter } = require('./engineConsoleAdapter');

const VALID_SOURCES = ['director', 'trio', 'auto'];

// deps: { cfg, now, log } — passed through to each adapter.
//
// `--source director|trio|auto` selects the take/off-air detector. The engine-
// console CLEAR detector is ORTHOGONAL (it adds only the profile-cleanup clear a
// take-out detector can't see) and is OPT-IN via `--engine-console`, so the
// default recorder is unchanged.
function buildAdapters(cfg = {}, deps = {}) {
  const source = VALID_SOURCES.includes(cfg.source) ? cfg.source : 'auto';
  const adapters = [];
  if (source === 'director' || source === 'auto') adapters.push(new DirectorAdapter(deps));
  if (source === 'trio' || source === 'auto') adapters.push(new TrioAdapter(deps));
  if (cfg.engineConsole) adapters.push(new EngineConsoleAdapter(deps));
  return adapters;
}

module.exports = { buildAdapters, VALID_SOURCES, DirectorAdapter, TrioAdapter, EngineConsoleAdapter };
