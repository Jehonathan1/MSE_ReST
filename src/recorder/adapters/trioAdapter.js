// src/recorder/adapters/trioAdapter.js
//
// Trio detection adapter — the **STOMP** channel-state (8582) detector. The
// channel-state walk is the proven logic from branch STOMP_VERSION_060425
// ("MSE Template & Channel Monitor") — feed.entry.content['state:channel'].
// state:layer(name=middle, type=transition_logic).state:transition_logic_layer[]
// .@based_on -> active set; off-air = an element dropping out of that set
// between frames — relocated behind the adapter interface and sharing the same
// parseChannelState() the replay/test path uses.
//
// Signals, all derived from the channel-state feed:
//   take    — an element entering the channel's active set
//   off-air — an element dropping out of the active set
//   state   — a compact snapshot of the active set, emitted on change
// (A content *change* while an element stays on air is Pilot-sourced — the core's
//  content-poll emits it as `change`; the channel-state feed carries set
//  membership, not field content, exactly as in the proven branch.)
//
// DESTINATIONS (proven branch subscribeToProfile/subscribeToChannel/
// subscribeToChannelStates):
//   /feeds/channelstate                                    global, channel-name independent
//   /state/profile/%2Fconfig%2Fprofiles%2F<profile>        profile state
//   /state/channel/%2Fconfig%2Fprofiles%2F<profile>%2F<channel>   per-channel state
//
// The PRIMARY subscription is the GLOBAL `/feeds/channelstate` feed (the Stage-1
// work capture went silent because the per-channel subscription used a wrong
// channel name). The per-channel/profile subscriptions are best-effort
// supplements, only built when --profile/--channel are configured. A
// channel-state watchdog warns loudly if NOTHING arrives within a few seconds —
// the only way round-1's silent wrong-channel failure could recur.
//
// CONTRACT (see ./index.js):
//   - `source` 'trio'; `needsActor` false; `needsStomp` true
//   - emits 'take'/'off-air' {elementId,...} and 'state' {channel, active[]}
//   - attachStomp(subscribe) once on connect; subscribe(destination, bodyCallback)
//   - stop()

const { EventEmitter } = require('events');
const { parseChannelState } = require('../parsers');

const DEFAULT_CHANNEL_STATE_TIMEOUT_MS = 5000;

class TrioAdapter extends EventEmitter {
  constructor({ cfg = {}, now = () => new Date().toISOString(), log = () => {} } = {}) {
    super();
    this.source = 'trio';
    this.needsActor = false;
    this.needsStomp = true;

    this.cfg = cfg;
    this.now = now;
    this.log = log;

    // This adapter tracks its OWN view of the active set so it never off-airs an
    // element the Director adapter put on air (the core de-dupes across both).
    this.active = new Map();  // elementId -> { templateId, isTemplate }
    this.lastSig = null;

    this.gotChannelState = false;
    this.watchdog = null;
  }

  attachStomp(subscribe) {
    // PRIMARY: the global channel-state feed — independent of the channel name.
    subscribe('/feeds/channelstate', (body) => { if (body) this.handleChannelState(body); });

    // SUPPLEMENT (best-effort): explicit profile + per-channel state, only when
    // the names are configured. Built exactly as the proven branch builds them;
    // a wrong name here is harmless — the global feed above remains primary.
    if (this.cfg.profile) {
      const enc = encodeURIComponent;
      const profileDest = `/state/profile/%2Fconfig%2Fprofiles%2F${enc(this.cfg.profile)}`;
      subscribe(profileDest, () => {}); // profile metadata; not needed for set detection
      this.log(`[trio] subscribed profile state: ${profileDest}`);
      if (this.cfg.channel) {
        const channelDest = `/state/channel/%2Fconfig%2Fprofiles%2F${enc(this.cfg.profile)}%2F${enc(this.cfg.channel)}`;
        subscribe(channelDest, (body) => { if (body) this.handleChannelState(body); });
        this.log(`[trio] subscribed channel state: ${channelDest}`);
      } else {
        this.log('[trio] --channel not set -> per-channel subscription skipped (global feed only)');
      }
    } else {
      this.log('[trio] --profile/--channel not set -> only the global /feeds/channelstate feed is subscribed');
    }

    // Arm the watchdog: a wrong channel silently disabled detection in round 1.
    const ms = this.cfg.channelStateTimeoutMs || DEFAULT_CHANNEL_STATE_TIMEOUT_MS;
    this.watchdog = setTimeout(() => this._warnIfNoChannelState(), ms);
    if (this.watchdog.unref) this.watchdog.unref(); // never hold the process open
  }

  // Called by the watchdog timer (and unit-tested directly).
  _warnIfNoChannelState() {
    if (this.gotChannelState) return;
    const ms = this.cfg.channelStateTimeoutMs || DEFAULT_CHANNEL_STATE_TIMEOUT_MS;
    this.log(`[trio] WARNING: no channel-state received within ${ms}ms — verify --profile/--channel `
      + `(a wrong channel silently disabled detection in round 1). The Director adapter remains the `
      + `reliable off-air signal; Trio take/off-air will not fire until channel-state arrives.`);
  }

  handleChannelState(body) {
    if (!this.gotChannelState) {
      this.gotChannelState = true;
      if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    }

    const parsed = parseChannelState(body);
    const activeIds = parsed.active.map((a) => a.elementId);
    const sig = activeIds.slice().sort().join(',');

    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.emit('state', {
        channel: parsed.channelName,
        active: parsed.active.map((a) => ({ elementId: a.elementId, templateId: a.templateId, isTemplate: a.isTemplate })),
      });
    }

    // New elements entering the active set -> take.
    for (const a of parsed.active) {
      if (!this.active.has(a.elementId)) {
        this.active.set(a.elementId, { templateId: a.templateId, isTemplate: a.isTemplate });
        this.log(`[trio] on-air signal element ${a.elementId}`);
        this.emit('take', { elementId: a.elementId, templateId: a.templateId || null, isTemplate: !!a.isTemplate, basedOn: a.basedOn || null });
      }
    }
    // Elements that dropped out -> off-air.
    const set = new Set(activeIds);
    for (const id of Array.from(this.active.keys())) {
      if (!set.has(id)) {
        this.active.delete(id);
        this.log(`[trio] off-air signal element ${id}`);
        this.emit('off-air', { elementId: id });
      }
    }
  }

  stop() {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
  }
}

module.exports = { TrioAdapter, DEFAULT_CHANNEL_STATE_TIMEOUT_MS };
