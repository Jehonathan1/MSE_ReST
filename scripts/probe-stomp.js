#!/usr/bin/env node
// scripts/probe-stomp.js
// READ-ONLY survey probe for the MSE STOMP channel-state feed (ws, default 8582).
// Connects exactly as stompClient.js does, SUBSCRIBES only, logs frames, exits.
// No SEND beyond the STOMP CONNECT/SUBSCRIBE handshake. Never takes anything.
//
// Usage: node scripts/probe-stomp.js [host] [port] [profile] [channel]

const { Client } = require('@stomp/stompjs');
const W3CWebSocket = require('websocket').w3cwebsocket;

const host = process.argv[2] || '127.0.0.1';
const port = process.argv[3] || '8582';
const profile = process.argv[4] || null;          // e.g. Yonathan
const channel = process.argv[5] || null;          // e.g. "Awesome localhost"

const url = `ws://${host}:${port}`;
console.log(`[stomp-probe] connecting ${url} (READ-ONLY, subscribe only)`);

const client = new Client({
  webSocketFactory: () => new W3CWebSocket(url),
  connectHeaders: { login: 'guest', passcode: 'guest' },
  debug: () => {},
  reconnectDelay: 0,
  heartbeatIncoming: 4000,
  heartbeatOutgoing: 4000,
});

let frames = 0;

client.onConnect = () => {
  console.log('[stomp-probe] STOMP CONNECTED ok');

  // Always available: the aggregate channel-state feed.
  client.subscribe('/feeds/channelstate', (m) => {
    frames++;
    console.log(`\n----- /feeds/channelstate frame #${frames} (${m.body.length} bytes) -----`);
    console.log(m.body.length > 4000 ? m.body.slice(0, 4000) + '\n...[truncated]' : m.body);
  });
  console.log('[stomp-probe] subscribed /feeds/channelstate');

  // If a profile/channel were given, subscribe to those specific destinations too.
  if (profile) {
    const dest = `/state/profile/%2Fconfig%2Fprofiles%2F${encodeURIComponent(profile)}`;
    client.subscribe(dest, (m) => {
      frames++;
      console.log(`\n----- ${dest} frame (${m.body.length} bytes) -----`);
      console.log(m.body.slice(0, 4000));
    });
    console.log(`[stomp-probe] subscribed ${dest}`);
  }
  if (profile && channel) {
    const dest = `/state/channel/%2Fconfig%2Fprofiles%2F${encodeURIComponent(profile)}%2F${encodeURIComponent(channel)}`;
    client.subscribe(dest, (m) => {
      frames++;
      console.log(`\n----- ${dest} frame (${m.body.length} bytes) -----`);
      console.log(m.body.slice(0, 4000));
    });
    console.log(`[stomp-probe] subscribed ${dest}`);
  }

  // Listen a few seconds, then report and quit.
  setTimeout(() => {
    console.log(`\n[stomp-probe] received ${frames} frame(s) in window. closing.`);
    client.deactivate();
    setTimeout(() => process.exit(0), 300);
  }, 6000);
};

client.onStompError = (frame) => {
  console.error('[stomp-probe] STOMP error:', frame.headers['message']);
};
client.onWebSocketError = (e) => {
  console.error('[stomp-probe] WS error:', e && e.message ? e.message : e);
};
client.onWebSocketClose = (e) => {
  console.log(`[stomp-probe] WS closed (${e ? e.code : '?'})`);
};

client.activate();
setTimeout(() => { console.log('[stomp-probe] hard timeout'); process.exit(0); }, 12000);
