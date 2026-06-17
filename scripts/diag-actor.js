#!/usr/bin/env node
// scripts/diag-actor.js
// READ-ONLY actor diagnostic. Replicates the Director adapter's EXACT PepTalk
// handshake so we can see, on the wire, why the 2s `get /state/last_taken_element`
// poll produced no take during a live take. protocol + subscribe + get ONLY —
// never take/cue/clear/POST.
//
// Usage: node scripts/diag-actor.js <host> [port] [--noevents] [--id]
//   --noevents : negotiate `protocol peptalk noevents uri` (probe-style) instead
//                of the adapter's `events uri`.
//   --id       : prefix the protocol line with a command id (probe-style) instead
//                of the adapter's id-less _raw line.
// Default (no flags) = EXACTLY what directorAdapter.attachActor() sends today.

const W3CWebSocket = require('websocket').w3cwebsocket;

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith('--')) || '127.0.0.1';
const portArg = args.filter((a) => !a.startsWith('--'))[1];
const port = portArg || '8595';
const useNoEvents = args.includes('--noevents');
const useId = args.includes('--id');

const SUBSCRIPTIONS = [
  '/scheduler',
  '/scheduler/*/state/current',
  '/scheduler/*/element/*/lines/LM-Line_*/state/current',
  '/state/system/log',
  '/state/playout',
];

const url = `ws://${host}:${port}`;
const mode = useNoEvents ? 'noevents' : 'events';
console.log(`[diag] connecting ${url} (READ-ONLY) protocol=${mode} protocol-id=${useId}`);

const ws = new W3CWebSocket(url);
let id = 1;
const pending = new Map();

function cmd(text, kind) {
  const myId = id++;
  pending.set(myId, kind || text);
  ws.send(`${myId} ${text}\r\n`);
  return myId;
}
function raw(text) { ws.send(`${text}\r\n`); }

ws.onopen = () => {
  console.log('[diag] open; negotiating');
  const proto = `protocol peptalk ${mode} uri`;
  if (useId) cmd(proto, 'protocol'); else raw(proto);   // adapter uses raw (no id)
  for (const u of SUBSCRIPTIONS) cmd(`subscribe ${u}`, 'subscribe');
  let n = 0;
  const poll = () => {
    cmd('get /state', 'state');
    cmd('get /state/last_taken_element', 'last_taken');
    if (++n >= 5) { clearInterval(t); setTimeout(() => ws.close(), 1500); }
  };
  poll();
  const t = setInterval(poll, 2000);
};

let frame = 0;
ws.onmessage = (m) => {
  const data = typeof m.data === 'string' ? m.data : m.data.toString('utf8');
  const head = data.slice(0, 200).replace(/\r?\n/g, '\\n');
  const hasLastTaken = data.includes('last_taken_element');
  const hasPath = data.includes('<entry name="path">');
  const idMatch = data.match(/^(\d+)\s+(begin|ok|error)\b/);
  const tag = idMatch ? `${idMatch[2].toUpperCase()} id=${idMatch[1]} kind=${pending.get(parseInt(idMatch[1], 10)) || '?'}` : 'UNSOLICITED/CONT';
  console.log(`\n[frame ${frame++}] ${tag}${hasPath ? ' <PATH>' : ''}${hasLastTaken ? ' <LASTTAKEN>' : ''} len=${data.length}`);
  console.log(`  head: ${head}${data.length > 200 ? ' ...[trunc]' : ''}`);
  if (idMatch && (idMatch[2] === 'ok' || idMatch[2] === 'error')) pending.delete(parseInt(idMatch[1], 10));
};

ws.onerror = (e) => console.error('[diag] error:', e && e.message ? e.message : e);
ws.onclose = () => { console.log('\n[diag] closed'); process.exit(0); };
setTimeout(() => { try { ws.close(); } catch (e) {} }, 15000);
