#!/usr/bin/env node
// scripts/probe-mse.js
// READ-ONLY survey probe for a Media Sequencer Engine.
// Connects to the PepTalk actor (ws, default 8595), negotiates the protocol,
// and issues a fixed set of `get` commands to dump the shape of the tree.
// It NEVER takes/cues/clears/POSTs anything — `protocol` + `get` only.
//
// Usage: node scripts/probe-mse.js [host] [port] [extraPath ...]
//   node scripts/probe-mse.js 127.0.0.1 8595
//   node scripts/probe-mse.js 127.0.0.1 8595 /config/profiles/Yonathan

const W3CWebSocket = require('websocket').w3cwebsocket;

const host = process.argv[2] || '127.0.0.1';
const port = process.argv[3] || '8595';
const extraPaths = process.argv.slice(4);

// The paths we want to inspect to learn the tree shape. Read-only.
const PATHS = [
  '/',
  '/config',
  '/config/profiles',
  '/state',
  '/state/last_taken_element',
  '/storage',
  '/directory',
  '/external',
  ...extraPaths,
];

const url = `ws://${host}:${port}`;
console.log(`[probe] connecting to PepTalk actor ${url} (READ-ONLY)`);

const ws = new W3CWebSocket(url);
let id = 1;
const pending = new Map(); // id -> path
let queue = [];
let done = false;

function send(cmd, path) {
  const myId = id++;
  pending.set(myId, path || cmd);
  const frame = `${myId} ${cmd}\r\n`;
  ws.send(frame);
  return myId;
}

ws.onopen = () => {
  console.log('[probe] connected; negotiating protocol');
  send('protocol peptalk noevents uri', 'protocol');
  // Give the protocol ack a beat, then fire the gets.
  queue = PATHS.slice();
  setTimeout(pump, 300);
};

function pump() {
  if (queue.length === 0) {
    // allow late responses, then close
    setTimeout(() => { done = true; ws.close(); }, 1500);
    return;
  }
  const p = queue.shift();
  send(`get ${p}`, p);
  setTimeout(pump, 400);
}

ws.onmessage = (msg) => {
  const data = typeof msg.data === 'string' ? msg.data : msg.data.toString('utf8');
  // Identify which command this answers (leading id)
  const m = data.match(/^(\d+)\s+(ok|error)\b/);
  let label = '';
  if (m) {
    const rid = parseInt(m[1], 10);
    label = pending.has(rid) ? ` [${pending.get(rid)}]` : '';
    pending.delete(rid);
  }
  const trimmed = data.length > 6000 ? data.slice(0, 6000) + '\n...[truncated]' : data;
  console.log(`\n----- response${label} -----\n${trimmed}`);
};

ws.onerror = (err) => {
  console.error('[probe] websocket error:', err && err.message ? err.message : err);
};

ws.onclose = () => {
  console.log('\n[probe] connection closed');
  process.exit(0);
};

// Safety: never hang forever
setTimeout(() => { if (!done) { console.log('[probe] timeout, closing'); ws.close(); } }, 15000);
