// src/recorder/adapters/directorAdapter.js
//
// Director detection adapter — the **actor**-based (PepTalk, 8595) detector.
//
// It is the reliable take-out / off-air path ported from
// director-with-out:src/server/websocket/websocketServer.js. Two signals:
//
//   take    — from `get /state/last_taken_element` (the proven Stage-1 take
//             path) AND a streamed last_taken notification. UNCHANGED behaviour;
//             it just lives here now.
//   off-air — NEW: from the director stream's A/O/out state on the element's
//             scheduler line. stateValue === 'A' ⇒ take, else ⇒ out. This does
//             NOT depend on the --channel name being correct, which is why it
//             survives the misconfiguration that left the Stage-1 STOMP feed
//             silent at work.
//
// CONTRACT (the detection-adapter interface — see ./index.js):
//   - `source`      : tag stamped on the normalized events ('director')
//   - `needsActor`  : true  -> the core opens the actor socket for it
//   - `needsStomp`  : false
//   - emits 'take'    {elementId, templateId, isTemplate, basedOn}
//   - emits 'off-air' {elementId}
//   - attachActor(send)        : called once when the actor socket opens
//   - handleActorMessage(data) : called for every actor frame
//   - stop()                   : clear timers
//
// The adapter ONLY detects: it hands normalized references to the core, which
// owns the Pilot join, variant/exclusive derivation and the JSONL writer.

const { EventEmitter } = require('events');
const { parseLastTakenElement } = require('../parsers');
const { parseDirectorEvent } = require('../offair');

// The director/state paths to subscribe to — "important for 'out' actions"
// (lifted verbatim from director-with-out's startMonitoring()/connect).
const DIRECTOR_SUBSCRIPTIONS = [
  '/scheduler',
  '/scheduler/*/state/current',
  '/scheduler/*/element/*/lines/LM-Line_*/state/current',
  '/state/playout',
];

class DirectorAdapter extends EventEmitter {
  constructor({ cfg = {}, now = () => new Date().toISOString(), log = () => {} } = {}) {
    super();
    this.source = 'director';
    this.needsActor = true;
    this.needsStomp = false;

    this.cfg = cfg;
    this.now = now;
    this.log = log;

    this.send = null;
    this.msgId = 1;
    this.pending = new Map();          // actor command id -> kind
    this.lastTakenPath = null;         // de-dupe repeat last_taken polls
    this.currentActiveElementId = null; // single-active tracking, for attribution
    this.pollTimer = null;
  }

  // ---- actor connection (the core owns the socket; we only send/parse) ----
  attachActor(send) {
    this.send = send;
    // events ENABLED — required to receive the director-stream notifications
    // that carry the A/O (take/out) state. The Stage-1 recorder negotiated
    // `noevents`, so it never saw an 'out'.
    this._raw('protocol peptalk events uri');
    for (const uri of DIRECTOR_SUBSCRIPTIONS) this._cmd(`subscribe ${uri}`, 'subscribe');

    const poll = () => {
      this._cmd('get /state', 'state');
      this._cmd('get /state/last_taken_element', 'last_taken');
    };
    poll();
    this.pollTimer = setInterval(poll, this.cfg.pollIntervalMs || 2000);
  }

  _raw(text) {
    if (this.send) this.send(`${text}\r\n`);
  }

  _cmd(cmd, kind) {
    if (!this.send) return null;
    const id = this.msgId++;
    this.pending.set(id, kind);
    this.send(`${id} ${cmd}\r\n`);
    return id;
  }

  // ---- inbound actor frames ----
  handleActorMessage(data) {
    if (!data) return;

    // (a) Command responses — the proven take poll. Match the id to its kind.
    const m = data.match(/^(\d+)\s+(ok|error)\b/);
    if (m) {
      const id = parseInt(m[1], 10);
      const status = m[2];
      const kind = this.pending.get(id);
      this.pending.delete(id);
      if (kind === 'last_taken' && status === 'ok') this._handleLastTaken(data);
      return;
    }

    // (b) Streamed last_taken notification — also a take signal. director-with-out
    //     handles last_taken both polled and streamed; we mirror that so the take
    //     path is robust whether the MSE answers the poll or pushes the event.
    if (data.includes('last_taken_element') && data.includes('<entry name="path">')) {
      this._handleLastTaken(data);
      return;
    }

    // (c) Director-stream A/O/out notification -> the NEW off-air signal.
    const ev = parseDirectorEvent(data);
    if (ev) this._handleDirectorEvent(ev);
  }

  // take: from last_taken_element (proven path) — UNCHANGED logic, relocated.
  _handleLastTaken(data) {
    const ref = parseLastTakenElement(data);
    if (!ref || !ref.path || ref.path === this.lastTakenPath) return;
    this.lastTakenPath = ref.path;
    if (!ref.elementId) return;
    this.currentActiveElementId = ref.elementId;
    this.emit('take', {
      elementId: ref.elementId,
      templateId: ref.templateId || null,
      isTemplate: !!ref.isTemplate,
      basedOn: ref.basedOn || null,
    });
  }

  // A/O/out from the director stream. A only tracks the active element (take is
  // emitted from last_taken, the proven path); O/out emits the off-air.
  _handleDirectorEvent(ev) {
    if (ev.action === 'take') {
      if (ev.elementId) this.currentActiveElementId = ev.elementId;
      return;
    }
    // ev.action === 'out'
    const elementId = ev.elementId || this.currentActiveElementId;
    if (!elementId) {
      this.log(`[director] out signal (${ev.rule}) for line ${ev.lineName || '?'} — no element id to attribute, ignoring`);
      return;
    }
    this.log(`[director] OFF-AIR signal (${ev.rule}) element ${elementId} line ${ev.lineName || '?'}`);
    if (elementId === this.currentActiveElementId) this.currentActiveElementId = null;
    this.emit('off-air', { elementId });
  }

  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

module.exports = { DirectorAdapter, DIRECTOR_SUBSCRIPTIONS };
