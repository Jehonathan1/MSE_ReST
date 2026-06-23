// src/recorder/recorder.js
//
// Read-only MSE recorder. Owns the live connections, runs one or more detection
// adapters over them, joins Pilot content, and writes one JSON object per line
// (JSONL) to a timestamped file:
//
//   - PepTalk actor (8595)        -> Director adapter (take + off-air)
//   - STOMP channel-state (8582)  -> Trio adapter (take + off-air + state)
//   - Pilot REST (8177)           -> field content joined on every take/change
//
// Detection lives in the adapters (src/recorder/adapters/); the CORE here keeps
// the Pilot join, variant/exclusive derivation, the JSONL writer, the on-air map
// (which de-dupes overlapping signals from multiple adapters) and the change
// content-poll. Adapters only DETECT and hand normalized references to the core.
//
// It is strictly read-only: STOMP CONNECT/SUBSCRIBE, actor `protocol`+`get`+
// `subscribe`, axios GET to Pilot/MSE REST. There is no take/cue/clear/POST path.
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
  parseMseElementData,
  deriveVariant,
  deriveExclusive,
  contentSignature,
} = require('./parsers');
const { buildAdapters } = require('./adapters');

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
    // elementId -> { templateId, isTemplate, basedOn, content, contentPending, sig, takenAt }
    this.onAir = new Map();

    const outPath = opts.outPath || recordingPath(cfg.outDir, this.now().replace(/:/g, '-'));
    this.writer = opts.writer || new JsonlWriter(outPath);
    this.outPath = this.writer.filePath || outPath;

    this.timers = [];
    this.stopped = false;

    // Build + wire the detection adapters selected by --source. Each adapter
    // hands the core normalized references via 'take'/'off-air'/'state'; the
    // core stamps each event with the adapter's `source` tag.
    this.adapters = buildAdapters(cfg, { cfg, now: this.now, log: this.log });
    for (const a of this.adapters) {
      a.on('take', (ref) => { Promise.resolve(this._onTakeSignal(ref, a.source)).catch(() => {}); });
      a.on('off-air', ({ elementId }) => this._markOffAir(elementId, a.source));
      a.on('state', (snap) => this._record({ source: a.source, type: 'state', channel: snap.channel, active: snap.active }));
    }
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
        source: this.cfg.source,
        channelStateTimeoutMs: this.cfg.channelStateTimeoutMs,
        stripeTemplateId: this.cfg.stripeTemplateId,
        line1Field: this.cfg.line1Field,
        line2Field: this.cfg.line2Field,
        exclusiveField: this.cfg.exclusiveField,
      },
    });
    this.log(`[recorder] writing ${this.outPath}`);
    this.log(`[recorder] source=${this.cfg.source} -> adapters: ${this.adapters.map((a) => a.source).join(', ') || '(none)'}`);
    if (!this.cfg.pilotHost) {
      this.log('[recorder] no Pilot host configured -> takes recorded as contentPending:true');
    }

    // Only open the transports the selected adapters actually need.
    const needActor = this.adapters.some((a) => a.needsActor);
    const needStomp = this.adapters.some((a) => a.needsStomp);
    if (needActor) this._connectActor();
    if (needStomp) this._connectStomp();

    // Change detection: re-fetch on-air Pilot content on its own interval.
    if (this.cfg.contentPoll) {
      this.timers.push(setInterval(() => { this._refreshOnAirContent(); }, this.cfg.pollIntervalMs));
    }

    if (this.cfg.durationSec && this.cfg.durationSec > 0) {
      this.timers.push(setTimeout(() => {
        this.log(`[recorder] duration ${this.cfg.durationSec}s reached, stopping`);
        this.stop();
      }, this.cfg.durationSec * 1000));
    }
    return this;
  }

  // ---- PepTalk actor leg (owned by the core; Director adapter drives it) ----
  _connectActor() {
    const url = `ws://${this.cfg.mseHost}:${this.cfg.actorPort}`;
    this.log(`[recorder] actor connecting ${url}`);
    const ws = new W3CWebSocket(url);
    this.actorWs = ws;
    const actorAdapters = this.adapters.filter((a) => a.needsActor);

    ws.onopen = () => {
      this._record({ source: 'actor', type: 'status', event: 'connected' });
      const send = (frame) => {
        if (this.actorWs && this.actorWs.readyState === this.actorWs.OPEN) this.actorWs.send(frame);
      };
      for (const a of actorAdapters) if (a.attachActor) a.attachActor(send);
    };
    ws.onmessage = (m) => {
      const data = typeof m.data === 'string' ? m.data : m.data.toString('utf8');
      for (const a of actorAdapters) if (a.handleActorMessage) a.handleActorMessage(data);
    };
    ws.onerror = (e) => {
      this._record({ source: 'actor', type: 'status', event: 'error', message: e && e.message ? e.message : String(e) });
    };
    ws.onclose = () => {
      if (!this.stopped) this._record({ source: 'actor', type: 'status', event: 'closed' });
    };
  }

  // ---- STOMP channel-state leg (owned by the core; Trio adapter drives it) ----
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
    const stompAdapters = this.adapters.filter((a) => a.needsStomp);

    client.onConnect = () => {
      this._record({ source: 'stomp', type: 'status', event: 'connected' });
      // Adapter-friendly subscribe: hand the body string to the adapter callback.
      const subscribe = (dest, cb) => client.subscribe(dest, (msg) => cb(msg && msg.body));
      for (const a of stompAdapters) if (a.attachStomp) a.attachStomp(subscribe);
    };
    client.onStompError = (frame) => {
      this._record({ source: 'stomp', type: 'status', event: 'error', message: frame.headers['message'] });
    };
    client.onWebSocketClose = () => {
      if (!this.stopped) this._record({ source: 'stomp', type: 'status', event: 'closed' });
    };
    client.activate();
  }

  // ---- take / change / off-air (core — Pilot join + on-air map + de-dupe) ----

  // Called by an adapter's 'take' signal. `source` is the adapter tag.
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
      mseSig: null, // live MSE-data baseline (§8.3), set on the first successful read
      takenAt: this.now(),
      taken: false, // the take record is not written until its Pilot fetch resolves
    });

    const resolved = await this._fetchContent(ref.elementId);
    const entry = this.onAir.get(ref.elementId);
    if (!entry) return; // went off-air before content resolved
    const templateId = (resolved.content && resolved.content.templateId) || ref.templateId || null;
    entry.templateId = templateId;
    entry.content = resolved.content;
    entry.contentPending = resolved.pending;
    entry.sig = contentSignature(resolved.content);
    entry.taken = true;

    // Single-occupancy: at this site only one Stripe occupies the scheduler line
    // (LM-Line_1) at a time, so a NEW stripe take IS the previous stripe's off
    // air. The replaced element never emits its own OUT here — takes are detected
    // by the actor's last_taken poll, which is decoupled from the director-stream
    // 'A' events, so the replacement is invisible at the adapter layer. We derive
    // it deterministically in the core instead. Scoped to stripe-replaces-stripe:
    // an exclusive (separate template/layer) co-exists with a stripe.
    if (this.isStripe(templateId)) {
      for (const [otherId, otherEntry] of this.onAir) {
        if (otherId === ref.elementId) continue;
        if (otherEntry.taken && this.isStripe(otherEntry.templateId)) this._markOffAir(otherId, source);
      }
    }

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
    for (const [elementId, entry] of this.onAir) {
      // Skip elements whose take record hasn't been written yet — the take's own
      // Pilot fetch establishes the baseline signature. Without this guard the
      // content-poll races that fetch and emits a spurious change BEFORE the take.
      if (!entry.taken) continue;
      // (1) saved Pilot DB element (Line edits that DO write back to Pilot).
      if (this.cfg.pilotHost) await this._refreshPilotContent(elementId, entry);
      // (2) live MSE element data (on-air edits, §8.3 — these never reach Pilot).
      await this._refreshMseContent(elementId, entry);
    }
  }

  // Pilot-sourced change detection (the saved DB element). Unchanged from Stage 2;
  // an on-air edit does NOT touch Pilot (§8.3), so this catches only DB writes.
  async _refreshPilotContent(elementId, entry) {
    const resolved = await this._fetchContent(elementId);
    if (!resolved.content) return;
    const sig = contentSignature(resolved.content);
    if (sig === entry.sig) return; // no change
    const cur = this.onAir.get(elementId);
    if (!cur) return;
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

  // Live-MSE change detection (§8.3 on-air edit). The edited text lives on the MSE
  // element node's `<entry name="data">` subnodes, read via PepTalk on the actor
  // socket the recorder already holds. A SEPARATE baseline (entry.mseSig) is kept
  // because the MSE and Pilot sources can name/shape fields differently — comparing
  // MSE-against-MSE is the robust signal. The first successful read establishes the
  // baseline (no emit); later reads emit one `change` when the live signature moves.
  // An absent/transient live node (e.g. /data/VCP/... when nothing is taken, §8.5)
  // is tolerated — it simply yields no comparison this tick.
  async _refreshMseContent(elementId, entry) {
    const resolved = await this._fetchMseElementData(elementId);
    if (!resolved || !resolved.content) return; // live node absent — nothing to compare
    const sig = contentSignature(resolved.content);
    if (entry.mseSig == null) { entry.mseSig = sig; return; } // establish baseline
    if (sig === entry.mseSig) return; // identical — no change
    entry.mseSig = sig;
    const cur = this.onAir.get(elementId);
    if (!cur) return;
    cur.content = resolved.content;
    cur.contentPending = false;
    const templateId = resolved.content.templateId || cur.templateId;
    cur.templateId = templateId;
    this._record({
      source: 'mse',
      type: 'change',
      elementId,
      templateId,
      isStripe: this.isStripe(templateId),
      content: resolved.content,
      contentPending: false,
      variant: deriveVariant(resolved.content, this.cfg.line2Field),
      exclusive: deriveExclusive(resolved.content, this.cfg.exclusiveField),
      pilotXml: undefined, // MSE-sourced; no Pilot XML provenance
    });
  }

  // Read the LIVE on-air content for an element from the MSE element node's
  // `<entry name="data">` via the Director adapter's PepTalk socket (§8.3/§8.5).
  // Follows last_taken's node (the live working copy where on-air edits land) and
  // falls back to the element's pilotdb node. Returns { content } or { content:null }
  // when the live node is absent/unreadable. Single-occupancy at this site (one
  // Stripe on the scheduler line at a time) makes last_taken's node the on-air
  // element's node; confirm multi-occupancy resolution on the next live trip.
  async _fetchMseElementData(elementId) {
    const director = this.adapters.find(
      (a) => a.source === 'director' && typeof a.getNode === 'function');
    if (!director) return { content: null };
    const path = director.lastTakenPath || `/external/pilotdb/elements/${elementId}`;
    let xml = null;
    try { xml = await director.getNode(path); } catch (e) { xml = null; }
    if (!xml) return { content: null };
    return { content: parseMseElementData(xml, elementId) };
  }

  // Called by an adapter's 'off-air' signal. The on-air-map check is the
  // cross-adapter de-dupe: only the FIRST adapter to report a given element
  // going off air records it (and an element never on air records nothing).
  _markOffAir(elementId, source) {
    if (!this.onAir.has(elementId)) return;
    const entry = this.onAir.get(elementId);
    this.onAir.delete(elementId);
    this._record({
      source: source || 'stomp',
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
    for (const a of this.adapters) { try { if (a.stop) a.stop(); } catch (e) { /* ignore */ } }
    this._record({ source: 'recorder', type: 'session', event: 'stop', eventCount: this.writer.count });
    try { if (this.stompClient) this.stompClient.deactivate(); } catch (e) { /* ignore */ }
    try { if (this.actorWs && this.actorWs.readyState === this.actorWs.OPEN) this.actorWs.close(); } catch (e) { /* ignore */ }
    await this.writer.close();
    this.log(`[recorder] stopped; ${this.writer.count} events -> ${this.outPath}`);
    this.emit('stopped', { outPath: this.outPath, count: this.writer.count });
  }
}

module.exports = { Recorder, JsonlWriter, recordingPath, SCHEMA_VERSION };
