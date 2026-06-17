// src/recorder/adapters/directorAdapter.js
//
// Director detection adapter — the **actor**-based (PepTalk, 8595) detector.
//
// OUT detection follows the OFFICIAL Media Sequencer PepTalk model (Vizrt "Media
// Sequencer document and API", §"The PepTalk Protocol"): with events enabled, the
// server reflects VDOM changes as uri-form events using five verbs (delete /
// insert / move / replace / set). An element going off air surfaces as a
// `set`/`replace` on its transition-logic state node (active 'A' -> inactive 'O')
// or a `delete` removing it from the active state path. Classification of each
// frame is in ../offair.js; this adapter owns the *stateful* parts:
//
//   - begin-framing: the server sends `<id> begin` before events caused by OUR
//     own command <id> (e.g. a subscribe's initial-state snapshot). Such events
//     are self-caused and are NOT read as fresh external on/off-air actions —
//     "this can be used to detect whether an event is caused by you or not"
//     (official §"Client messages"). Read-only clients still honor it so the
//     subscribe snapshot can't masquerade as a live take.
//   - line-name cross-reference: an OUT that names no element id is resolved
//     against the line->element map this adapter builds from take ('A') events,
//     then (last resort) attributed to the current active element. (KB §4b:
//     "cross-reference by line name when element ID is missing".)
//
// Two signals:
//   take    — from the actor `last_taken_element` (the proven Stage-1 take path),
//             polled and streamed. UNCHANGED; relocated here.
//   off-air — from the director-stream OUT verbs above. Keyed on the element /
//             scheduler-line path, NOT the channel name, so a wrong --channel
//             can never silently disable it (the Stage-1 work-capture failure).
//
// CONTRACT (the detection-adapter interface — see ./index.js):
//   - `source` 'director'; `needsActor` true; `needsStomp` false
//   - emits 'take' {elementId, templateId, isTemplate, basedOn} / 'off-air' {elementId}
//   - attachActor(send) once on open; handleActorMessage(data) per frame; stop()
//
// The adapter ONLY detects; the core owns the Pilot join, variant/exclusive
// derivation, the on-air map (cross-adapter de-dupe) and the JSONL writer.

const { EventEmitter } = require('events');
const { parseLastTakenElement } = require('../parsers');
const { parseDirectorEvent } = require('../offair');

// Paths to subscribe to. `/scheduler` covers its whole subtree, so the narrower
// line subscriptions are belt-and-suspenders (kept to match the battle-tested
// director-with-out set); any duplicate delivery is idempotently de-duped by the
// core's on-air map. `/state/system/log` is the KB §4b show/profile-teardown
// fallback; `/state/playout` carries playout channel state.
const DIRECTOR_SUBSCRIPTIONS = [
  '/scheduler',
  '/scheduler/*/state/current',
  '/scheduler/*/element/*/lines/LM-Line_*/state/current',
  '/state/system/log',
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
    this.pending = new Map();           // actor command id -> kind
    this.ownBegin = new Set();          // our command ids inside a begin..ok window
    this.lastTakenPath = null;          // de-dupe repeat last_taken polls
    this.currentActiveElementId = null; // single-active tracking, for attribution
    this.lineToElement = new Map();     // scheduler line name -> elementId (from takes)
    this.pollTimer = null;
  }

  // ---- actor connection (the core owns the socket; we only send/parse) ----
  attachActor(send) {
    this.send = send;
    // Events ENABLED (negotiate WITHOUT `noevents`) — required to receive the
    // external VDOM events that carry the A/O take/out transitions. `uri` makes
    // the server serialize events in path form so each one names its element /
    // line. The Stage-1 recorder negotiated `noevents`, so it never saw an out.
    // (Official §"Protocol command": noevents = "client does not require events
    // that are not direct results of the client's commands".)
    // The protocol command MUST carry a command id like every other PepTalk
    // command — an id-less line is rejected with `protocol error not implemented
    // peptalk`, leaving the socket in a non-PepTalk mode where every `get`/
    // `subscribe` fails (verified on MSE 5.3.5, the work site). Negotiation must
    // succeed before any get can resolve last_taken.
    this._cmd('protocol peptalk events uri', 'protocol');
    for (const uri of DIRECTOR_SUBSCRIPTIONS) this._cmd(`subscribe ${uri}`, 'subscribe');

    const poll = () => {
      this._cmd('get /state', 'state');
      this._cmd('get /state/last_taken_element', 'last_taken');
    };
    poll();
    this.pollTimer = setInterval(poll, this.cfg.pollIntervalMs || 2000);
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

    // (a0) Begin-framing: `<id> begin` opens the event stream caused by OUR
    //      command <id>. Events inside the window are self-caused (e.g. a
    //      subscribe's initial-state snapshot) and must NOT be read as fresh
    //      external takes/outs.
    let m = data.match(/^(\d+)\s+begin\b/);
    if (m) {
      const id = parseInt(m[1], 10);
      if (this.pending.has(id)) this.ownBegin.add(id);
      return;
    }

    // (a) Command responses — match id to kind; also closes an own-begin window.
    m = data.match(/^(\d+)\s+(ok|error)\b/);
    if (m) {
      const id = parseInt(m[1], 10);
      const status = m[2];
      const kind = this.pending.get(id);
      this.pending.delete(id);
      this.ownBegin.delete(id);
      if (kind === 'last_taken' && status === 'ok') this._handleLastTaken(data);
      return;
    }

    // (b) Streamed last_taken notification — a take signal. (A `get` reply
    //     payload, not a VDOM event, so it is honored regardless of begin state.)
    if (data.includes('last_taken_element') && data.includes('<entry name="path">')) {
      this._handleLastTaken(data);
      return;
    }

    // (c) Director-stream VDOM event -> take/off-air. Suppressed while inside an
    //     own-command begin window (those events are self-caused, not external).
    if (this.ownBegin.size > 0) return;
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

  // A/O (and delete/replace) from the director stream. 'A' only tracks the active
  // element + its line (take is emitted from last_taken, the proven path); an OUT
  // resolves its element id then emits the off-air. NOTE: a same-line stripe
  // replacement (B takes the line A still holds, with no OUT for A) is NOT derived
  // here — the 'A' stream is decoupled from the last_taken take path at this site,
  // so it fires unreliably. The core derives that off-air deterministically via
  // single-occupancy when the new stripe take is recorded (see recorder.js).
  _handleDirectorEvent(ev) {
    if (ev.action === 'take') {
      if (ev.elementId) {
        this.currentActiveElementId = ev.elementId;
        if (ev.lineName) this.lineToElement.set(ev.lineName, ev.elementId); // on-air line map
      }
      return;
    }

    // ev.action === 'out' — resolve the element id, in order:
    //   1) the id named in the event itself, else
    //   2) cross-reference the scheduler line name against the on-air line map, else
    //   3) the current active element (a show/profile teardown with no id or line).
    let elementId = ev.elementId;
    let how = 'id';
    if (!elementId && ev.lineName && this.lineToElement.has(ev.lineName)) {
      elementId = this.lineToElement.get(ev.lineName);
      how = 'line-name';
    }
    if (!elementId) { elementId = this.currentActiveElementId; how = 'active-element'; }

    if (!elementId) {
      this.log(`[director] out signal (${ev.rule}) line ${ev.lineName || '?'} — no element id to attribute, ignoring`);
      return;
    }
    this.log(`[director] OFF-AIR signal (${ev.rule}/${ev.verb || 'heuristic'}) element ${elementId} via ${how} (line ${ev.lineName || '?'})`);
    if (ev.lineName) this.lineToElement.delete(ev.lineName);
    if (elementId === this.currentActiveElementId) this.currentActiveElementId = null;
    this.emit('off-air', { elementId });
  }

  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

module.exports = { DirectorAdapter, DIRECTOR_SUBSCRIPTIONS };
