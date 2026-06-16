// src/recorder/recorder.js
//
// Read-only MSE recorder. Joins the three streams the convergence bridge needs
// and writes one JSON object per line (JSONL) to a timestamped file:
//
//   1. STOMP channel-state (8582)  -> on-air / off-air per element  (stompClient.js logic)
//   2. PepTalk actor      (8595)   -> explicit take signal via last_taken_element
//   3. Pilot REST         (8177)   -> field content joined on every take (work-only)
//
// It is strictly read-only: STOMP CONNECT/SUBSCRIBE, actor `protocol`+`get`,
// axios GET to Pilot/MSE REST. There is no take/cue/clear/POST path anywhere.
//
// When the Pilot host is unset or unreachable, takes are still recorded with
// content:null + contentPending:true + the unresolved element reference, so the
// same binary runs clean at home and fills content in at work.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const axios = require('axios');
const { Client } = require('@stomp/stompjs');
const W3CWebSocket = require('websocket').w3cwebsocket;

const {
  parsePilotElement,
  parseLastTakenElement,
  parseChannelState,
  deriveVariant,
  deriveExclusive,
  contentSignature,
} = require('./parsers');

const SCHEMA_VERSION = 1;

// --- JSONL writer ----------------------------------------------------------

class JsonlWriter {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.count = 0;
  }
  write(obj) {
    this.stream.write(JSON.stringify(obj) + '\n');
    this.count++;
  }
  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

// Build the timestamped recording path. Colons are illegal in Windows filenames,
// so the ISO timestamp is sanitised to dashes.
function recordingPath(outDir, isoNow) {
  const safe = isoNow.replace(/:/g, '-');
  return path.join(outDir, `${safe}.jsonl`);
}

// --- Recorder --------------------------------------------------------------

class Recorder extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.log = opts.logger || console.log;
    this.now = opts.now || (() => new Date().toISOString());

    this.seq = 0;
    this.lastTakenPath = null;
    this.lastActiveSig = null;
    // elementId -> { templateId, isTemplate, basedOn, content, contentPending, sig, takenAt }
    this.onAir = new Map();
    this.pendingActorCmds = new Map(); // actor command id -> kind
    this.actorMsgId = 1;

    const outPath = opts.outPath || recordingPath(cfg.outDir, this.now().replace(/:/g, '-'));
    this.writer = opts.writer || new JsonlWriter(outPath);
    this.outPath = this.writer.filePath || outPath;

    this.timers = [];
    this.stopped = false;
  }

  // ---- event emission ----
  _record(ev) {
    const event = Object.assign({ ts: this.now(), seq: this.seq++ }, ev);
    this.writer.write(event);
    this.emit('event', event);
    return event;
  }

  isStripe(templateId) {
    return this.cfg.stripeTemplateId != null && templateId != null
      && String(templateId) === String(this.cfg.stripeTemplateId);
  }

  start() {
    // Session header — makes the file self-sufficient for offline replay.
    this._record({
      source: 'recorder',
      type: 'session',
      schemaVersion: SCHEMA_VERSION,
      event: 'start',
      config: {
        mseHost: this.cfg.mseHost,
        stompPort: this.cfg.stompPort,
        actorPort: this.cfg.actorPort,
        restPort: this.cfg.restPort,
        pilotHost: this.cfg.pilotHost,
        pilotPort: this.cfg.pilotPort,
        profile: this.cfg.profile,
        channel: this.cfg.channel,
        stripeTemplateId: this.cfg.stripeTemplateId,
        line1Field: this.cfg.line1Field,
        line2Field: this.cfg.line2Field,
        exclusiveField: this.cfg.exclusiveField,
      },
    });
    this.log(`[recorder] writing ${this.outPath}`);
    if (!this.cfg.pilotHost) {
      this.log('[recorder] no Pilot host configured -> takes recorded as contentPending:true');
    }

    this._connectActor();
    this._connectStomp();

    if (this.cfg.durationSec && this.cfg.durationSec > 0) {
      this.timers.push(setTimeout(() => {
        this.log(`[recorder] duration ${this.cfg.durationSec}s reached, stopping`);
        this.stop();
      }, this.cfg.durationSec * 1000));
    }
    return this;
  }

  // ---- PepTalk actor leg (take signal) ----
  _connectActor() {
    const url = `ws://${this.cfg.mseHost}:${this.cfg.actorPort}`;
    this.log(`[recorder] actor connecting ${url}`);
    const ws = new W3CWebSocket(url);
    this.actorWs = ws;

    ws.onopen = () => {
      this._record({ source: 'actor', type: 'status', event: 'connected' });
      this._actorSend('protocol peptalk noevents uri', 'protocol');
      // Poll state + last_taken_element, and re-check on-air content for changes.
      const poll = () => {
        this._actorSend('get /state', 'state');
        this._actorSend('get /state/last_taken_element', 'last_taken');
        if (this.cfg.contentPoll) this._refreshOnAirContent();
      };
      poll();
      this.timers.push(setInterval(poll, this.cfg.pollIntervalMs));
    };
    ws.onmessage = (m) => {
      const data = typeof m.data === 'string' ? m.data : m.data.toString('utf8');
      this._onActorMessage(data);
    };
    ws.onerror = (e) => {
      this._record({ source: 'actor', type: 'status', event: 'error', message: e && e.message ? e.message : String(e) });
    };
    ws.onclose = () => {
      if (!this.stopped) this._record({ source: 'actor', type: 'status', event: 'closed' });
    };
  }

  _actorSend(cmd, kind) {
    if (!this.actorWs || this.actorWs.readyState !== this.actorWs.OPEN) return null;
    const id = this.actorMsgId++;
    this.pendingActorCmds.set(id, kind);
    this.actorWs.send(`${id} ${cmd}\r\n`);
    return id;
  }

  _onActorMessage(data) {
    const m = data.match(/^(\d+)\s+(ok|error)\b/);
    if (!m) return;
    const id = parseInt(m[1], 10);
    const status = m[2];
    const kind = this.pendingActorCmds.get(id);
    this.pendingActorCmds.delete(id);

    if (kind === 'last_taken') {
      if (status === 'error') return; // inexistent at home -> no take
      const ref = parseLastTakenElement(data);
      if (ref && ref.path && ref.path !== this.lastTakenPath) {
        this.lastTakenPath = ref.path;
        if (ref.elementId) this._onTakeSignal(ref, 'actor');
      }
    }
  }

  // ---- STOMP channel-state leg (on-air/off-air) ----
  _connectStomp() {
    const url = `ws://${this.cfg.mseHost}:${this.cfg.stompPort}`;
    this.log(`[recorder] stomp connecting ${url}`);
    const client = new Client({
      webSocketFactory: () => new W3CWebSocket(url),
      connectHeaders: { login: 'guest', passcode: 'guest' },
      debug: () => {},
      reconnectDelay: 5000,
      heartbeatIncoming: 4000,
      heartbeatOutgoing: 4000,
    });
    this.stompClient = client;

    client.onConnect = () => {
      this._record({ source: 'stomp', type: 'status', event: 'connected' });
      client.subscribe('/feeds/channelstate', (msg) => {
        if (msg.body) this._onChannelState(msg.body);
      });
      // Optional explicit per-channel subscription when names are known.
      if (this.cfg.profile) {
        const pDest = `/state/profile/%2Fconfig%2Fprofiles%2F${encodeURIComponent(this.cfg.profile)}`;
        client.subscribe(pDest, () => {});
        if (this.cfg.channel) {
          const cDest = `/state/channel/%2Fconfig%2Fprofiles%2F${encodeURIComponent(this.cfg.profile)}%2F${encodeURIComponent(this.cfg.channel)}`;
          client.subscribe(cDest, (msg) => { if (msg.body) this._onChannelState(msg.body); });
        }
      }
    };
    client.onStompError = (frame) => {
      this._record({ source: 'stomp', type: 'status', event: 'error', message: frame.headers['message'] });
    };
    client.onWebSocketClose = () => {
      if (!this.stopped) this._record({ source: 'stomp', type: 'status', event: 'closed' });
    };
    client.activate();
  }

  _onChannelState(body) {
    const parsed = parseChannelState(body);
    const activeIds = parsed.active.map((a) => a.elementId);
    const sig = activeIds.slice().sort().join(',');

    // Record a compact state snapshot only when the active set changes.
    if (sig !== this.lastActiveSig) {
      this.lastActiveSig = sig;
      this._record({
        source: 'stomp',
        type: 'state',
        channel: parsed.channelName,
        active: parsed.active.map((a) => ({ elementId: a.elementId, templateId: a.templateId, isTemplate: a.isTemplate })),
      });
    }

    // New elements entering the active set -> take signal.
    for (const a of parsed.active) {
      if (!this.onAir.has(a.elementId)) this._onTakeSignal(a, 'stomp');
    }
    // Elements that dropped out -> off-air.
    const activeSet = new Set(activeIds);
    for (const id of Array.from(this.onAir.keys())) {
      if (!activeSet.has(id)) this._markOffAir(id);
    }
  }

  // ---- take / change / off-air ----
  async _onTakeSignal(ref, source) {
    if (this.onAir.has(ref.elementId)) return; // already on air; changes via content-poll
    // Reserve the slot synchronously so concurrent signals don't double-fire.
    this.onAir.set(ref.elementId, {
      templateId: ref.templateId || null,
      isTemplate: !!ref.isTemplate,
      basedOn: ref.basedOn || null,
      content: null,
      contentPending: true,
      sig: '',
      takenAt: this.now(),
    });

    const resolved = await this._fetchContent(ref.elementId);
    const entry = this.onAir.get(ref.elementId);
    if (!entry) return; // went off-air before content resolved
    const templateId = (resolved.content && resolved.content.templateId) || ref.templateId || null;
    entry.templateId = templateId;
    entry.content = resolved.content;
    entry.contentPending = resolved.pending;
    entry.sig = contentSignature(resolved.content);

    this._record({
      source,
      type: 'take',
      elementId: ref.elementId,
      templateId,
      isTemplate: !!ref.isTemplate,
      basedOn: ref.basedOn || null,
      isStripe: this.isStripe(templateId),
      content: resolved.content,
      contentPending: resolved.pending,
      contentError: resolved.error || null,
      variant: resolved.content ? deriveVariant(resolved.content, this.cfg.line2Field) : null,
      exclusive: resolved.content ? deriveExclusive(resolved.content, this.cfg.exclusiveField) : null,
      pilotXml: this.cfg.storeRaw ? (resolved.raw || null) : undefined,
    });
  }

  async _refreshOnAirContent() {
    if (!this.cfg.pilotHost) return;
    for (const [elementId, entry] of this.onAir) {
      const resolved = await this._fetchContent(elementId);
      if (!resolved.content) continue;
      const sig = contentSignature(resolved.content);
      if (sig === entry.sig) continue; // no change
      const cur = this.onAir.get(elementId);
      if (!cur) continue;
      cur.content = resolved.content;
      cur.contentPending = false;
      cur.sig = sig;
      const templateId = resolved.content.templateId || cur.templateId;
      cur.templateId = templateId;
      this._record({
        source: 'pilot',
        type: 'change',
        elementId,
        templateId,
        isStripe: this.isStripe(templateId),
        content: resolved.content,
        contentPending: false,
        variant: deriveVariant(resolved.content, this.cfg.line2Field),
        exclusive: deriveExclusive(resolved.content, this.cfg.exclusiveField),
        pilotXml: this.cfg.storeRaw ? (resolved.raw || null) : undefined,
      });
    }
  }

  _markOffAir(elementId) {
    const entry = this.onAir.get(elementId);
    this.onAir.delete(elementId);
    this._record({
      source: 'stomp',
      type: 'off-air',
      elementId,
      templateId: entry ? entry.templateId : null,
      isStripe: entry ? this.isStripe(entry.templateId) : false,
    });
  }

  // Returns { content, pending, error, raw }. Never throws.
  async _fetchContent(elementId) {
    if (!this.cfg.pilotHost) {
      return { content: null, pending: true, error: 'no pilot host configured', raw: null };
    }
    const url = `http://${this.cfg.pilotHost}:${this.cfg.pilotPort}/dataelements/${elementId}`;
    try {
      const res = await axios.get(url, {
        headers: { Accept: 'application/atom+xml;type=entry' },
        timeout: this.cfg.pilotTimeoutMs,
      });
      if (res.status === 200) {
        const raw = typeof res.data === 'string' ? res.data : String(res.data);
        return { content: parsePilotElement(raw, elementId), pending: false, error: null, raw };
      }
      return { content: null, pending: true, error: `pilot http ${res.status}`, raw: null };
    } catch (err) {
      return { content: null, pending: true, error: err.message, raw: null };
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    this.timers = [];
    this._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: this.writer.count });
    try { if (this.stompClient) this.stompClient.deactivate(); } catch (e) { /* ignore */ }
    try { if (this.actorWs && this.actorWs.readyState === this.actorWs.OPEN) this.actorWs.close(); } catch (e) { /* ignore */ }
    await this.writer.close();
    this.log(`[recorder] stopped; ${this.writer.count} events -> ${this.outPath}`);
    this.emit('stopped', { outPath: this.outPath, count: this.writer.count });
  }
}

module.exports = { Recorder, JsonlWriter, recordingPath, SCHEMA_VERSION };
