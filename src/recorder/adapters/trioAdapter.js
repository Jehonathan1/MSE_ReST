// src/recorder/adapters/trioAdapter.js
//
// Trio detection adapter — the **STOMP** channel-state (8582) detector. This is
// the Stage-1 on-air/off-air path relocated behind the adapter interface; it is
// functional, not a stub. Stage 2c can extend it (Trio-specific element shapes)
// with zero core changes.
//
// Signals, all derived from the channel-state feed:
//   take    — an element entering the channel's active set
//   off-air — an element dropping out of the active set
//   state   — a compact snapshot of the active set, emitted on change
//
// IMPORTANT (the Stage-1 failure mode): at work the per-channel subscription used
// a wrong channel name and the feed went silent, so no off-air fired. Here the
// PRIMARY subscription is the GLOBAL `/feeds/channelstate` feed (channel-name
// independent); the explicit per-channel subscription is a best-effort
// supplement only. A wrong/unknown channel name therefore cannot disable
// detection — and the Director adapter is the reliable off-air signal regardless.
//
// CONTRACT (see ./index.js):
//   - `source`      : 'trio'
//   - `needsActor`  : false
//   - `needsStomp`  : true   -> the core opens the STOMP client for it
//   - emits 'take'    {elementId, templateId, isTemplate, basedOn}
//   - emits 'off-air' {elementId}
//   - emits 'state'   {channel, active:[{elementId, templateId, isTemplate}]}
//   - attachStomp(subscribe)        : called once when STOMP connects;
//                                     subscribe(destination, bodyCallback)
//   - stop()

const { EventEmitter } = require('events');
const { parseChannelState } = require('../parsers');

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
  }

  attachStomp(subscribe) {
    // PRIMARY: the global channel-state feed — independent of the channel name.
    subscribe('/feeds/channelstate', (body) => { if (body) this.handleChannelState(body); });

    // SUPPLEMENT (best-effort): explicit per-channel state, only when the
    // profile/channel names are configured. A wrong name here is harmless — the
    // global feed above remains the primary source.
    if (this.cfg.profile) {
      const enc = encodeURIComponent;
      subscribe(`/state/profile/%2Fconfig%2Fprofiles%2F${enc(this.cfg.profile)}`, () => {});
      if (this.cfg.channel) {
        subscribe(
          `/state/channel/%2Fconfig%2Fprofiles%2F${enc(this.cfg.profile)}%2F${enc(this.cfg.channel)}`,
          (body) => { if (body) this.handleChannelState(body); }
        );
      }
    }
  }

  handleChannelState(body) {
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

  stop() { /* no timers; the core owns the STOMP client lifecycle */ }
}

module.exports = { TrioAdapter };
