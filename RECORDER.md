# MSE Recorder & Replay

A **read-only** recorder that captures live on-air MSE activity to a replayable
JSONL file, joining the three streams the [viz-to-gsap convergence bridge](../viz-to-gsap/convergence/CAPTURE-PLAN.md)
needs, plus a `replay.js` harness that reconstructs the Stripe on-air timeline
offline.

> **Read-only, full stop.** The recorder only `SUBSCRIBE`s (STOMP), `get`s
> (PepTalk actor), and `GET`s (Pilot/MSE REST). There is no take / cue / clear /
> POST path. It is safe to run against a live show channel.

## The three streams

| Stream | Port | What it gives | Source logic reused |
|---|---|---|---|
| STOMP channel-state | 8582 (ws) | on-air / off-air per element | `src/server/websocket/stompClient.js` |
| PepTalk actor | 8595 (ws) | explicit take signal (`get /state/last_taken_element`) | `src/server/websocket/websocketServer.js` |
| Pilot REST | 8177 (http) | field content (`GET /dataelements/<id>` → Line_1/Line_2) | `fetchPilotElementDetails` / `parsePilotElementData` |

The state feed carries only the element **reference**, not the text, so the
recorder fires a Pilot fetch on every take and joins the content into the event.

## Quick start

```bash
npm install            # @stomp/stompjs, websocket, axios, xml2js

# At home (rehearsal rig, no Pilot) — proves the state + take legs; takes (if any)
# are recorded contentPending:true. --duration auto-stops; omit it to run until Ctrl-C.
node record.js --mse-host 127.0.0.1 --duration 20

# At work — point at the real MSE + Pilot, with the real names/IDs:
node record.js \
  --mse-host <MSE_IP> \
  --profile "<ProfileName>" --channel "<ChannelName>" \
  --pilot-host <PILOT_IP> --pilot-port 8177 \
  --stripe-template <TEMPLATE_ID> --line2-field 1 --exclusive-field <N>

# Replay / validate a recording (reconstruct the Stripe timeline):
node replay.js recordings/<timestamp>.jsonl
node replay.js recordings/<timestamp>.jsonl --json     # machine-readable

npm test               # offline regression (fixture + replay), 13 tests
```

npm script aliases: `npm run record -- <flags>`, `npm run replay -- <file>`, `npm test`.

## Configuration

Precedence: **CLI flag > env / `.env` > built-in default.** Nothing about the
Stripe is hard-coded — profile, channel, Pilot host and template id are all args.

| CLI flag | env var | Default | Meaning |
|---|---|---|---|
| `--mse-host` | `MSE_HOST` | `127.0.0.1` | MSE host. A full URL (`http://h:8580`) is accepted and reduced to the bare host. |
| `--stomp-port` | `STOMP_PORT` | `8582` | STOMP channel-state ws port. |
| `--actor-port` | `MSE_WEBSOCKET_PORT` | `8595` | PepTalk actor ws port. |
| `--rest-port` | `MSE_REST_PORT` | `8580` | MSE REST port. |
| `--pilot-host` | `PILOT_HOST` | *(unset)* | Pilot Data Server host. **Unset ⇒ takes stay `contentPending:true`.** |
| `--pilot-port` | `PILOT_PORT` | `8177` | Pilot REST port. |
| `--profile` | `PROFILE_NAME` | *(unset)* | MSE profile (enables the explicit per-channel STOMP subscription). |
| `--channel` | `CHANNEL_NAME` | *(unset)* | MSE channel name. |
| `--stripe-template` | `TARGET_TEMPLATE_ID` | `16082` | Template id that marks an element as **the Stripe** (`isStripe`). Confirm at work. |
| `--line1-field` | `LINE1_FIELD` | `0` | Pilot numeric field for Line_1. |
| `--line2-field` | `LINE2_FIELD` | `1` | Pilot numeric field for Line_2 — drives 1-line vs 2-line. |
| `--exclusive-field` | `EXCLUSIVE_FIELD` | *(unset)* | Pilot field for the exclusive ("בלעדי") badge. |
| `--out` | `RECORD_DIR` | `recordings` | Output directory. |
| `--poll-interval` | `POLL_INTERVAL_MS` | `2000` | Actor poll + on-air content re-check interval (ms). |
| `--no-content-poll` | — | on | Disable re-fetching on-air Pilot content (change/exclusive detection). |
| `--no-store-raw` | — | on | Stop embedding raw Pilot XML in take/change events. |
| `--duration` | — | *(until Ctrl-C)* | Auto-stop after N seconds. |

> The repo `.env` ships `MSE_HOST=http://8.217.127.27:8580` (a work value the
> legacy server ignores). For a **local** run pass `--mse-host 127.0.0.1` to
> override it; see `LOCAL-MSE-SURVEY.md` for why the rig is otherwise bare.

## JSONL schema

One JSON object per line. Common fields: `ts` (wall-clock ISO-8601), `seq`
(monotonic), `source` (`recorder` | `actor` | `stomp` | `pilot`), `type`. The
first line is always a `session` header carrying the full config, so the file is
self-sufficient for offline replay.

| `type` | source | Key fields |
|---|---|---|
| `session` | recorder | `event` (`start`\|`stop`), `schemaVersion`, `config{}` (start), `eventCount` (stop) |
| `status` | actor / stomp | `event` (`connected`\|`closed`\|`error`), `message?` |
| `state` | stomp | `channel`, `active[]` (`{elementId, templateId, isTemplate}`) — emitted only when the active set changes |
| `take` | actor / stomp | `elementId`, `templateId`, `isTemplate`, `basedOn`, `isStripe`, `content`, `contentPending`, `contentError`, `variant`, `exclusive`, `pilotXml?` |
| `change` | pilot | same content fields as `take` — emitted when an on-air element's Pilot content changes (Line edit / exclusive toggle) |
| `off-air` | stomp | `elementId`, `templateId`, `isStripe` |

`content` (when resolved) is `{ elementId, templateId, templateName, fields{}, texts[] }`,
where `fields` are the numeric Pilot fields (`"0"`, `"1"`, …) and `texts` are the
non-empty values. When the Pilot host is unset/unreachable, `content` is `null`,
`contentPending` is `true`, and `variant`/`exclusive` are `null` until resolved at work.

`variant` is `ONE_LINE` / `TWO_LINE`, derived from whether the `line2Field` is
empty — exactly as the real `line2Change` script decides.

## Replay

`replay.js` reconstructs each **Stripe instance**: when it took, its content, its
variant (and variant/exclusive transitions over its life), and when it left. It
validates completeness and **fails loudly** (`exit 1`) on a truncated/corrupt
recording — a half-written line, or an element left on air with no `off-air` and
no clean `session stop`. A still-on-air element *is* accepted when the session
closed cleanly (it was simply on air when recording stopped).

```
$ node replay.js test/fixtures/stripe-lifecycle.jsonl
=== Stripe timeline (template 16082; line2Field=1) ===
Stripe instance #1  element 20001  template 16082
  took: 2026-06-16T18:00:05.050Z
  left: 2026-06-16T18:00:40.000Z
   @...05.050Z  ONE_LINE  exclusive=off  "ראש הממשלה נואם"
   @...20.000Z  TWO_LINE  exclusive=off  "ראש הממשלה נואם בכנסת | דיון על תקציב המדינה"
   @...27.000Z  TWO_LINE  exclusive=ON   "...| בלעדי"
   @...34.000Z  TWO_LINE  exclusive=off  "..."
```

## Tests & fixtures

`npm test` runs the offline regression (`node --test`):

- `test/fixtures/stripe-lifecycle.jsonl` — a synthetic full Stripe lifecycle
  (take-in 1-line → change → 2-line → exclusive on/off → take-out) that **embeds
  the raw Pilot XML** for each take/change. The test proves `parsePilotElement`
  reproduces the recorded `content` from that XML — i.e. the Pilot-join code is
  verified ahead of the office capture.
- `test/fixtures/stripe-lifecycle.truncated.jsonl` — a deliberately truncated
  recording; the test asserts `replay` fails loudly on it.
- Regenerate the fixtures with `npm run make-fixtures`.

## Read-only survey tools

`scripts/probe-mse.js <host> <port>` and `scripts/probe-stomp.js <host> <port>`
dump the actor tree and the channel-state feed read-only — used to produce
`LOCAL-MSE-SURVEY.md`. Re-run them at work to confirm the live tree shape.
