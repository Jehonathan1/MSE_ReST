---
tags: mse, vizrt-monitor, websocket, stomp
summary: Vizrt Element Monitor over STOMP WebSocket; live MSE element data; StreamDeck-integrated trigger control.
key_files: record.js, replay.js, RECORDER.md
---

# MSE Viewer

## Lessons

- **The local Media Sequencer is a bare rehearsal rig.** Ports up (REST 8580,
  actor 8595, STOMP 8582) but `/config/profiles` is empty, `/state/last_taken_element`,
  `/storage`, `/external` are `inexistent`, `/feeds/channelstate` emits nothing,
  and Pilot 8177 is down. So the `Yonathan` / `Awesome localhost` / template
  `16082` names in the old code are stale — they 404 / are absent. All three
  transport legs *handshake* locally (that's what the rig proves); a live take
  and the Line_1/Line_2 content are work-only. Full map in `LOCAL-MSE-SURVEY.md`.
- **On-air detection (proven shape):** STOMP channel-state →
  `state:channel` → `state:layer name="middle" type="transition_logic"` →
  `state:transition_logic_layer/@based_on` → `/pilotdb/elements/<id>` (element)
  or `/<id>/dataitems/last_open_template` (template). Off-air = element drops
  from the active set between frames.
- **Stage 1 recorder is read-only and decoupled from the legacy server.** It does
  not import `src/server/config/config.js` (which now pulls in `dotenv`); it keeps
  its own config resolver. The repo `.env` `MSE_HOST` is a full work URL the
  legacy server ignores — pass `--mse-host 127.0.0.1` for local runs (the recorder
  also strips scheme/port from a host value defensively).
- **1-line vs 2-line is `is Line_2 empty?`** — a single derivation
  (`deriveVariant`) shared by recorder and replay, matching the real `line2Change`
  script. Exclusive ("בלעדי") is a separate configurable field.
- **Detection is normalized behind adapters: Director = actor, Trio = STOMP.**
  (`src/recorder/adapters/`.) Each adapter only DETECTS and emits the core's
  normalized `take`/`off-air` events tagged with its `source`; the core keeps the
  Pilot join, on-air map and JSONL writer. `--source director|trio|auto` picks
  which run (`auto` = both; the on-air-map `if (onAir.has(id)) return` de-dupes
  overlapping take **and** off-air across them). Stage 2c's Trio work slots in
  with zero core changes.
- **Take-out / off-air comes from the actor DIRECTOR stream, not STOMP.** The
  element's on-air state rides its scheduler **line** path as a letter —
  `state/current A` ⇒ take, else (`O`/`current out`) ⇒ out (`offair.js`, ported
  from `director-with-out`'s `checkForOffAirActions`). It's keyed on the element
  **path**, not the channel **name**, so a wrong `--channel` can't disable it.
  Requires `protocol peptalk events uri` (Stage 1 used `noevents`, so it never
  saw an `out`).
- **STOMP was silent under the Director path at work — expected, not a bug.** The
  Stage-1 work capture (`recordings/2026-06-16T14-29-22.775Z.jsonl`) recorded 3
  takes (template **16097**) + 1 change but **zero off-airs**: every take came
  from the actor `last_taken_element` while the STOMP channel-state feed emitted
  nothing (per-channel subscription used a wrong channel name). That capture was
  hard-killed, so its `replay` truncation warning (dangling on-air element, no
  session stop) is **expected** — the takes/changes still reconstruct. STOMP is
  now a best-effort supplement; the Director adapter is the reliable signal.
- **(Stage 2c) KB cross-validation of the two programs' OUT signals.** Two
  programs drive on-air at i24, and the split is now confirmed against both the
  official MSE docs and the proven branches: **Viz Director → PepTalk
  `/scheduler` + `/state/system/log`** (OUT detection); **Viz Trio → STOMP
  `/feeds/channelstate`** (off-air by absence from the `transition_logic` layer).
  `--source auto` runs both; the on-air map records a both-legs take/out once.
- **(Stage 2c) The official PepTalk event model is the authority — it generalizes
  the branch heuristic.** The Vizrt *"Media Sequencer document and API"* (§*The
  PepTalk Protocol*) defines exactly **five event verbs — delete/insert/move/
  replace/set** — serialized in uri form. An OUT is a `set`/`replace` on the
  element's transition-logic state node (`A`→`O`) **or** a `delete` removing it
  from the active state path. The `director-with-out` regex (`set text
  …/state/current O`) *is* the `set` verb — the official model just adds the
  `delete`/`replace` forms (now handled in `offair.js`) and the **`<id> begin`
  framing** that marks events caused by *our own* command (so a `subscribe`'s
  initial-state snapshot can't masquerade as a live take; external events have no
  preceding own-`begin`). Events must be enabled (`events`, not `noevents`).
  Where the doc and a branch heuristic differ, the doc wins.
- **(Stage 2c) The green `/scheduler`-only fixture had masked the missing
  `/state/system/log` signal.** Stage 2b's lone A→O actor fixture passed, which
  hid that the KB's three-signal OUT (`/scheduler` + system-log cleanup +
  line-name cross-reference) was incomplete — `director-with-out` *subscribed*
  `/state/system/log` but never parsed the `Cleaning up viz-handlers…` cleanup
  line, and there was no line-name fallback for an **ID-less** OUT. Both are now
  implemented and each has its own fixture (`stripe-cleanup`, `stripe-byline`),
  alongside an official-`delete`-verb fixture (`stripe-delete`). Lesson: a single
  happy-path fixture is not coverage — fixture **per signal**.
- **(Stage 3) The Stage-2d captures are SUFFICIENT for the Stage-4 bridge —
  replay is now the formal sufficiency check + a stable timeline contract.**
  `timeline.js` (`buildTimeline` / `node timeline.js <file> --emit|--report`, also
  `replay.js --emit|--report`) emits the normalized bridge contract per Stripe
  instance — `{elementId, templateId, tookAt, leftAt|stillOnAir, variant,
  states:[{at,variant,texts,fields}], exclusiveGate:[{at,on}]}` — documented in
  `TIMELINE-SCHEMA.md`. The 16-event end-to-end capture reconstructs to **5
  TWO_LINE Stripe instances + one exclusive-gate window + clean close**, committed
  as `test/fixtures/live/2026-06-17T09-15-40.203Z.timeline.json` (the gitignored
  `recordings/` captures are mirrored byte-for-byte under `test/fixtures/live/` so
  the artifact + its tests survive a fresh clone). The exclusive Gate is
  derived from the **co-airing template-16092 element** (take ⇒ gate ON on the
  concurrent stripe, off-air ⇒ gate OFF), kept OUT of the stripe list and folded
  into the concurrent stripe — NOT from a 16097 field. The Trio-only 4-event
  capture correctly reconstructs to **zero instances + clean close** (a PASS, not a
  failure). **Known non-blocking gaps** (surfaced by `--report`, not papered over):
  (1) the exclusive-badge Pilot field number is still unidentified, so per-stripe
  `exclusive` stays `null` — the bridge uses the 16092 gate instead; (2) no live
  ONE_LINE stripe was captured — variant is derived ("is Line_2 empty?") and
  unit-proven, not faked; (3) a template-only take would carry `elementId:null` —
  not a Stripe data element, none in these captures. **Stage-3 issue: CLOSED — the
  capture is sufficient; the bridge can be built against the committed contract.**

## Stage-1 deliverable: recorder → JSONL → replay (for viz-to-gsap Stage 3/4)

`record.js` writes one JSON object per line (see `RECORDER.md` for the full
schema). The line types Stage 3/4 consume: a `session` header (carries config:
`stripeTemplateId`, `line1Field`, `line2Field`, `exclusiveField`), `take` /
`change` events with joined Pilot `content { fields{}, texts[] }` + `variant`
(`ONE_LINE`/`TWO_LINE`) + `exclusive`, and `off-air`. `take`/`change` also embed
`pilotXml` (raw) for provenance. `replay.js` reconstructs the per-instance Stripe
timeline (take → content/variant transitions → off-air) and is the offline
verifier. The bridge maps: take→In, change→Change, off-air→Out, exclusive→Gate.

## How to work in this project
- Legacy monitor: `npm install` then `npm start`. Configure via `.env`.
- **Recorder:** `node record.js [flags]`; **replay:** `node replay.js <file>`;
  **tests:** `npm test`. See `RECORDER.md`.
- StreamDeck integration described in `STREAMDECK.md`.

## File map
- `record.js` / `replay.js` — read-only recorder CLI + offline replay/validate harness
- `timeline.js` / `TIMELINE-SCHEMA.md` — Stage-4 bridge-contract emitter + sufficiency check (`--emit` / `--report`) and its schema doc
- `src/recorder/` — `recorder.js` (core: connections + join + JSONL), `parsers.js` (shared parse/derive), `offair.js` (official PepTalk five-verb OUT classifier + KB fallbacks), `recorderConfig.js`
- `src/recorder/adapters/` — detection-adapter interface: `directorAdapter.js` (actor; begin-framing + line-name cross-ref), `trioAdapter.js` (STOMP; channel-state + watchdog), `index.js` (`buildAdapters` by `--source`)
- `test/` — regression suite + committed Stripe-lifecycle fixtures
- `scripts/probe-mse.js` / `scripts/probe-stomp.js` — read-only survey probes
- `LOCAL-MSE-SURVEY.md` — local MSE tree map + "confirm at work" checklist
- `RECORDER.md` — recorder/replay usage, config, JSONL schema
- `src/server/index.js` — legacy HTTP + STOMP/WebSocket monitor bridge
- `src/server/websocket/` — STOMP frame handlers (connection logic the recorder reuses)
- `STREAMDECK.md` — Elgato StreamDeck button setup
