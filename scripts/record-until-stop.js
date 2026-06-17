#!/usr/bin/env node
// scripts/record-until-stop.js
//
// Thin wrapper around the read-only Recorder (src/recorder/recorder.js). Capture
// is IDENTICAL and strictly read-only — same Recorder, same config resolution;
// subscribe (STOMP) + get (actor) + GET (Pilot/REST) only, never take/cue/clear.
//
// It adds two things the bare `record.js` lacks, both needed when the recorder is
// launched as a Claude Code background job on Windows:
//   (a) one compact stdout line per event, so the run can be watched live;
//   (b) a clean IN-PROCESS stop triggered by a sentinel file — because a detached
//       background process here cannot receive a real Ctrl-C/SIGINT (verified:
//       CTRL_C_EVENT can't cross process groups; process.kill/taskkill hard-kill
//       and skip Node's handler, so no `session stop` line is written). Creating
//       the sentinel runs the SAME recorder.stop() a Ctrl-C would, writing the
//       final `session stop` line and producing a replay-valid recording.
//
// Stop cleanly by creating the sentinel file (default <outDir>/.stop):
//   touch recordings/director/.stop

const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('../src/recorder/recorderConfig');
const { Recorder } = require('../src/recorder/recorder');

const cfg = resolveConfig();
const stopFile = process.env.STOP_FILE || path.join(cfg.outDir, '.stop');
try { fs.rmSync(stopFile, { force: true }); } catch (e) { /* ignore */ }

const recorder = new Recorder(cfg);

// One compact stdout line per event — for live monitoring only; does not touch
// the recording (the JSONL is written independently by the Recorder).
recorder.on('event', (ev) => {
  try {
    if (['take', 'off-air', 'change', 'state'].includes(ev.type)) {
      const p = [`[EVT ${ev.seq}]`, ev.type.toUpperCase(), `source=${ev.source}`];
      if (ev.elementId != null) p.push(`el=${ev.elementId}`);
      if (ev.templateId != null) p.push(`tmpl=${ev.templateId}`);
      if (['take', 'change', 'off-air'].includes(ev.type)) p.push(`stripe=${!!ev.isStripe}`);
      if (ev.variant) p.push(`variant=${ev.variant}`);
      if (['take', 'change'].includes(ev.type)) p.push(`excl=${ev.exclusive == null ? 'n/a' : ev.exclusive}`);
      if (['take', 'change'].includes(ev.type)) {
        const texts = ev.content && ev.content.texts ? ev.content.texts.join(' | ')
          : (ev.contentPending ? '(content pending)' : '');
        if (texts) p.push(`"${texts}"`);
      }
      if (ev.type === 'state' && ev.active) p.push(`active=[${ev.active.map((a) => a.elementId).join(',')}]`);
      console.log(p.join(' '));
    } else if (ev.type === 'status') {
      console.log(`[EVT ${ev.seq}] STATUS ${ev.source} ${ev.event}${ev.message ? ' ' + ev.message : ''}`);
    }
  } catch (e) { /* never let logging break capture */ }
});

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[record-until-stop] clean stop (${reason}); flushing JSONL...`);
  await recorder.stop();
  process.exit(0);
}

recorder.start();
console.log(`[record-until-stop] OUTPUT_FILE=${recorder.outPath}`);
console.log(`[record-until-stop] STOP_FILE=${stopFile} (create this file to stop cleanly)`);

recorder.on('stopped', () => { if (!shuttingDown) process.exit(0); });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Poll for the sentinel — the agent-deliverable clean-stop trigger.
const poll = setInterval(() => {
  if (fs.existsSync(stopFile)) {
    clearInterval(poll);
    try { fs.rmSync(stopFile, { force: true }); } catch (e) { /* ignore */ }
    shutdown('stop-file');
  }
}, 400);
