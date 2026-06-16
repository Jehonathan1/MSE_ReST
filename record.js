#!/usr/bin/env node
// record.js — CLI entry for the read-only MSE recorder.
//
// Usage:
//   node record.js [--mse-host H] [--profile P] [--channel C]
//                  [--source director|trio|auto]
//                  [--pilot-host H] [--pilot-port 8177]
//                  [--stripe-template ID] [--line2-field 1] [--exclusive-field N]
//                  [--out recordings] [--duration SECONDS]
//
// At home (no Pilot): node record.js --duration 20
// At work:            node record.js --profile "<P>" --channel "<C>" \
//                       --pilot-host <IP> --stripe-template <ID>
//
// --source selects the detection adapter(s): director = actor-based take/off-air
// (reliable; channel-name independent), trio = STOMP channel-state, auto = both
// (default; the on-air map de-dupes overlapping signals).
//
// READ-ONLY: subscribes (STOMP), gets (actor), GETs (Pilot/REST). Never takes.

const { resolveConfig } = require('./src/recorder/recorderConfig');
const { Recorder } = require('./src/recorder/recorder');

const cfg = resolveConfig();

console.log('[record] config:', {
  mseHost: cfg.mseHost, stompPort: cfg.stompPort, actorPort: cfg.actorPort, restPort: cfg.restPort,
  profile: cfg.profile, channel: cfg.channel, source: cfg.source,
  pilotHost: cfg.pilotHost || '(unset -> contentPending)', pilotPort: cfg.pilotPort,
  stripeTemplateId: cfg.stripeTemplateId, line2Field: cfg.line2Field, exclusiveField: cfg.exclusiveField,
  outDir: cfg.outDir, durationSec: cfg.durationSec || '(until Ctrl-C)',
});

const recorder = new Recorder(cfg);
recorder.start();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[record] shutting down (flushing JSONL)...');
  await recorder.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
recorder.on('stopped', () => { if (!shuttingDown) process.exit(0); });
