#!/usr/bin/env node
// _cleanup-probe.js — READ-ONLY raw events-mode PepTalk tap for the profile-cleanup
// open question (mse-viewer issue 4 / NIGHT-PROMPT-cleanup-not-clearing.md).
//
// Resolves: when the operator does a profile/engine CLEANUP, does the MSE emit a
// raw-but-UNPARSED frame on the actor stream (which path/wording?), or truly
// nothing? The recorder records the cleanup as 0 lines; this tap shows every raw
// frame so we can see what (if anything) the MSE side carries.
//
// It is strictly READ-ONLY: `protocol` + `subscribe` + `get` only. It NEVER
// takes/cues/clears/POSTs. Unlike the recorder it negotiates EVENTS (not
// `noevents`) so it receives the external VDOM events — and it can NOT run
// alongside the recorder (the MSE grants events to a single client).
//
// Usage:
//   node _cleanup-probe.js [host] [port]
//     host default 127.0.0.1, port default 8595 (actor ws).
//   While it runs, drive the engine: type a tag + Enter between each step to
//   stamp the log, e.g.  take <Enter> … takeout <Enter> … cleanup <Enter>.
//   Cross-check the engine console in parallel with:
//     node ../viz-cmd/viz-cmd.js --console-setup   (once)
//     node ../viz-cmd/viz-cmd.js --console 80       (after each step)
//   Ctrl-C to stop.

const W3CWebSocket = require('websocket').w3cwebsocket;
const readline = require('readline');

const host = process.argv[2] || '127.0.0.1';
const port = process.argv[3] || '8595';

// EVENTS mode (NOT noevents) so external take/out/cleanup VDOM events are received.
const PROTOCOL = 'protocol peptalk events uri';
const SUBSCRIPTIONS = [
  '/scheduler',
  '/scheduler/*',
  '/state/system/log',
  '/state/playout',
  '/state/playout_slots_notifications',
  '/state/last_taken_element',
];
// Read-only polls — snapshot the paths a cleanup *might* clear, to catch a state
// change that is not pushed as an event.
const POLLS = ['/state/last_taken_element', '/state/playout', '/state/playout_slots_notifications'];

const url = `ws://${host}:${port}`;
let id = 1;
const pending = new Map();

function ts() { return new Date().toISOString(); }
function send(ws, cmd, kind) {
  const myId = id++;
  pending.set(myId, kind || cmd);
  ws.send(`${myId} ${cmd}\r\n`);
  return myId;
}

console.log(`[cleanup-probe] connecting ${url} (READ-ONLY, EVENTS mode)`);
console.log('[cleanup-probe] type a tag + Enter between steps (take / takeout / cleanup); Ctrl-C to stop\n');

const ws = new W3CWebSocket(url);

ws.onopen = () => {
  console.log(`${ts()}  >> ${PROTOCOL}`);
  send(ws, PROTOCOL, 'protocol');
  for (const uri of SUBSCRIPTIONS) send(ws, `subscribe ${uri}`, `subscribe ${uri}`);
  const poll = () => { for (const p of POLLS) send(ws, `get ${p}`, `poll ${p}`); };
  poll();
  setInterval(poll, 2000);
};

ws.onmessage = (msg) => {
  const data = typeof msg.data === 'string' ? msg.data : msg.data.toString('utf8');
  const m = data.match(/^(\d+)\s+(ok|error|begin)\b/);
  let tag = '';
  if (m) {
    const rid = parseInt(m[1], 10);
    if (pending.has(rid)) { tag = ` [${pending.get(rid)}]`; if (m[2] !== 'begin') pending.delete(rid); }
  } else {
    tag = ' [EVENT]'; // an unsolicited frame = an external VDOM event (the interesting case)
  }
  const trimmed = data.length > 4000 ? data.slice(0, 4000) + ' …[trunc]' : data;
  console.log(`${ts()}${tag}  ${trimmed}`);
};

ws.onerror = (e) => console.error(`[cleanup-probe] ws error: ${e && e.message ? e.message : e}`);
ws.onclose = () => { console.log('[cleanup-probe] closed'); process.exit(0); };

// stdin tagging — stamp a marker so the raw log lines line up with the action.
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  console.log(`\n===================== TAG: ${line.trim() || '(mark)'} @ ${ts()} =====================\n`);
});

process.on('SIGINT', () => { try { ws.close(); } catch (e) { /* ignore */ } process.exit(0); });
