#!/usr/bin/env node
// scripts/night60-mirror-capture.js — TEST-ONLY mirror proof for night-60.
//
// Proves the downstream mirror reacts to the recorder's engine-cleanup off-air by
// running the REAL viz-to-gsap live-server against the recorder's JSONL and reading
// its cue stream. The repos stay SEPARATE: live-server is launched as its own
// process and the ONLY interface is the JSONL (input) + HTTP/SSE (output) — nothing
// from viz-to-gsap is imported here.
//
// Two captures, both fed the recorder's REAL take + REAL engine-cleanup off-air:
//   * connectSnapshot hold->clear — a live monitor (--tail) holding the on-air
//     stripe reports op=hold; after the cleanup off-air it reports op=clear. We feed
//     the JSONL truncated at the take (on air) vs at the engine off-air (cleared).
//   * streamed cues (--replay) — the full lifecycle streams op=reveal (take) then
//     op=takeout (off-air) per instance, the cues the conductor renders.

'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const EVID = path.join(__dirname, '..', 'test', 'fixtures', 'live', 'night60');
const REC = path.join(EVID, 'recorder.jsonl');
const LIVE_SERVER = path.join(__dirname, '..', '..', 'viz-to-gsap', 'convergence', 'live-server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = fs.readFileSync(REC, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// Truncate the REAL recorder JSONL at two points (no synthesis — same lines).
function writeUpTo(file, pred) {
  const out = [];
  for (const e of lines) { out.push(JSON.stringify(e)); if (pred(e)) break; }
  fs.writeFileSync(file, out.join('\n') + '\n');
}
const HOLD_JSONL = path.join(EVID, 'mirror.hold.jsonl');
const CLEAR_JSONL = path.join(EVID, 'mirror.clear.jsonl');
writeUpTo(HOLD_JSONL, (e) => e.type === 'take' && e.elementId === '20001');                       // ...up to the take (on air)
writeUpTo(CLEAR_JSONL, (e) => e.type === 'off-air' && e.elementId === '20001' && e.source === 'engine'); // ...up to the engine cleanup off-air

function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('health timeout')); });
  });
}
async function waitHealthy(port) {
  for (let i = 0; i < 40; i++) { try { const h = await getJSON(port, '/health'); if (h && h.ok) return true; } catch (e) {} await sleep(150); }
  throw new Error(`live-server on ${port} never became healthy`);
}

// Open the SSE cue stream, collect cue ops for `ms`, then close. Returns the op list.
function captureCues(port, ms) {
  return new Promise((resolve) => {
    const ops = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (frame.match(/^event:\s*(.+)$/m) || [])[1];
          const data = (frame.match(/^data:\s*(.+)$/m) || [])[1];
          if (ev === 'cue' && data) { try { ops.push(JSON.parse(data).op); } catch (e) {} }
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => { req.destroy(); resolve(ops); }, ms);
  });
}

function startLiveServer(args) {
  const child = spawn('node', [LIVE_SERVER, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  return child;
}

async function runOne({ label, mode, jsonl, port, captureMs }) {
  const args = mode === 'replay'
    ? ['--replay', jsonl, '--speed', '100', '--port', String(port)]   // compress the 10s lifecycle so one capture window sees it all
    : ['--tail', jsonl, '--port', String(port)];
  const child = startLiveServer(args);
  try {
    await waitHealthy(port);
    await sleep(900);                 // let the source fully ingest the file (+ takeout flush settles)
    const ops = await captureCues(port, captureMs);
    const timeline = await getJSON(port, '/timeline').catch(() => null);
    return { label, mode, port, ops, instances: Array.isArray(timeline && timeline.stripe) ? timeline.stripe.length : (timeline && timeline.instances) };
  } finally {
    child.kill();
    await sleep(200);
  }
}

(async () => {
  const out = {};
  out.hold = await runOne({ label: 'hold (stripe on air)', mode: 'tail', jsonl: HOLD_JSONL, port: 7901, captureMs: 1500 });
  out.clear = await runOne({ label: 'clear (after engine cleanup)', mode: 'tail', jsonl: CLEAR_JSONL, port: 7902, captureMs: 1500 });
  out.streamed = await runOne({ label: 'streamed lifecycle', mode: 'replay', jsonl: REC, port: 7903, captureMs: 3000 });

  console.log('hold    snapshot ops :', JSON.stringify(out.hold.ops));
  console.log('clear   snapshot ops :', JSON.stringify(out.clear.ops));
  console.log('streamed cue ops     :', JSON.stringify(out.streamed.ops));

  const checks = [];
  const c = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
  c('mirror op=hold while the stripe is on air', out.hold.ops.includes('hold'));
  c('mirror op=clear after the engine cleanup off-air', out.clear.ops.includes('clear'));
  c('mirror did NOT report hold after the cleanup', !out.clear.ops.includes('hold'));
  c('streamed lifecycle reveals then takes-out', out.streamed.ops.includes('reveal') && out.streamed.ops.includes('takeout'));

  fs.writeFileSync(path.join(EVID, 'mirror-state.json'), JSON.stringify(out, null, 2));
  console.log('\n[mirror] wrote', path.join(EVID, 'mirror-state.json'));
  process.exit(checks.every((x) => x.ok) ? 0 : 1);
})();
