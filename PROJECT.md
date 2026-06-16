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
- `src/recorder/` — `recorder.js` (join + JSONL), `parsers.js` (shared parse/derive), `recorderConfig.js`
- `test/` — regression suite + committed Stripe-lifecycle fixtures
- `scripts/probe-mse.js` / `scripts/probe-stomp.js` — read-only survey probes
- `LOCAL-MSE-SURVEY.md` — local MSE tree map + "confirm at work" checklist
- `RECORDER.md` — recorder/replay usage, config, JSONL schema
- `src/server/index.js` — legacy HTTP + STOMP/WebSocket monitor bridge
- `src/server/websocket/` — STOMP frame handlers (connection logic the recorder reuses)
- `STREAMDECK.md` — Elgato StreamDeck button setup
