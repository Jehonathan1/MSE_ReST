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
| PepTalk actor | 8595 (ws) | take signal + take-out / off-air | `src/server/websocket/websocketServer.js` |
| Pilot REST | 8177 (http) | field content (`GET /dataelements/<id>` → Line_1/Line_2) | `fetchPilotElementDetails` / `parsePilotElementData` |

A detection signal carries only the element **reference**, not the text, so the
recorder fires a Pilot fetch on every take and joins the content into the event.

## Detection-adapter architecture

On-air detection is normalized behind a **detection-adapter interface**
(`src/recorder/adapters/`). The **core** (`recorder.js`) owns the connections,
the Pilot join, variant/exclusive derivation, the on-air map and the JSONL
writer; **adapters only DETECT** and hand normalized references to the core.

| Adapter | Transport | Detects | `source` tag |
|---|---|---|---|
| **Director** | PepTalk **actor** (8595) | take (`last_taken_element`) **+ take-out / off-air** (director stream `A`/`O`) | `director` |
| **Trio** | **STOMP** channel-state (8582) | take + off-air + active-set `state` snapshots | `trio` |

Each adapter emits the recorder's normalized events — `take` / `off-air` (Trio
also `state`) with `{elementId, templateId, content, variant, exclusive, source}`
filled in by the core. `--source director|trio|auto` selects which adapter(s)
run (`auto` = both, the default). When both run, the core's on-air map
(`if (onAir.has(elementId)) return`) de-dupes overlapping take **and** off-air
signals, so the two adapters never double-record the same element. Adding a new
detector (e.g. Stage 2c's Trio extensions) needs no core change — it just
implements the adapter contract and emits `take`/`off-air`.

### Off-air detection (the Stage-2b fix)

The Stage-1 recorder detected **take** (from the actor `last_taken_element`) but
never captured a **take-out**: off-air was STOMP-driven, and at work the STOMP
channel-state feed was silent (the per-channel subscription used a wrong channel
name), so no off-air fired. The Director adapter fixes this by reading off-air
from the **actor director stream** instead, ported from the `director-with-out`
branch's `checkForOffAirActions()`:

- It negotiates `protocol peptalk events uri` (events **enabled** — Stage 1 used
  `noevents`, so it never saw an `out`) and subscribes to `/scheduler`,
  `/scheduler/*/state/current`,
  `/scheduler/*/element/*/lines/LM-Line_*/state/current` and `/state/playout`.
- An element's on-air state arrives on its scheduler **line** path as a single
  letter — **`state/current A` ⇒ take, anything else (`O` / `current out`) ⇒
  out** (`src/recorder/offair.js`). The element id is read from the message
  (`…/pilotdb/elements/<id>`) or, when absent, attributed to the current active
  element.
- This signal is keyed on the **element path**, not the channel **name** — so a
  wrong/unknown `--channel` can no longer silently disable off-air detection. The
  STOMP per-channel subscription is now a best-effort *supplement* (the global
  `/feeds/channelstate` feed is Trio's primary source); the Director adapter is
  the reliable off-air signal. The recorder logs which signal fired
  (`[director] OFF-AIR signal …` / `[trio] off-air signal …`).

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

npm test               # offline regression (fixtures + replay + adapters), 19 tests
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
| `--channel` | `CHANNEL_NAME` | *(unset)* | MSE channel name. Off-air detection no longer depends on this being correct — it's a best-effort STOMP supplement only. |
| `--source` | `SOURCE` | `auto` | Detection adapter(s): `director` (actor; reliable take-out), `trio` (STOMP channel-state), or `auto` (both; on-air map de-dupes). |
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
(monotonic), `source`, `type`. The first line is always a `session` header
carrying the full config (now including `source`), so the file is self-sufficient
for offline replay. `source` is the **transport** on connection events
(`recorder` | `actor` | `stomp`) and the **detection adapter** on the normalized
events (`director` | `trio` | `pilot`).

| `type` | source | Key fields |
|---|---|---|
| `session` | recorder | `event` (`start`\|`stop`), `schemaVersion`, `config{}` (start, incl. `source`), `eventCount` (stop) |
| `status` | actor / stomp | `event` (`connected`\|`closed`\|`error`), `message?` |
| `state` | trio | `channel`, `active[]` (`{elementId, templateId, isTemplate}`) — emitted only when the active set changes |
| `take` | director / trio | `elementId`, `templateId`, `isTemplate`, `basedOn`, `isStripe`, `content`, `contentPending`, `contentError`, `variant`, `exclusive`, `pilotXml?` |
| `change` | pilot | same content fields as `take` — emitted when an on-air element's Pilot content changes (Line edit / exclusive toggle) |
| `off-air` | director / trio | `elementId`, `templateId`, `isStripe` |

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
- `test/fixtures/stripe-takeout.actor.json` — a scripted **actor director-stream**
  take-in → out sequence (`state/current A` → `last_taken_element` → `state/current
  O`). The test feeds it to a real `Recorder` (Pilot join stubbed to Stripe
  content) and asserts the recorder **produces a `director`-sourced `off-air`**,
  then that `replay` reconstructs a complete (took → left) Stripe instance —
  proving the Stage-2b off-air detection ahead of the office capture.
- `test/fixtures/stripe-takeout.jsonl` — that recorder run's committed output, so
  `node replay.js test/fixtures/stripe-takeout.jsonl` reconstructs the lifecycle.
- Regenerate the fixtures with `npm run make-fixtures`.

## Standing TODO — the exclusive ("בלעדי") field number

The exclusive-badge Pilot field is still configurable via `--exclusive-field`
(unset by default) — its actual numeric field on template **16097** is unknown.
Identifying it is a **work-only** task: take an exclusive element on air and
inspect its `/dataelements/<id>` payload (or the captured `take`/`change`
`pilotXml`) for the field that toggles with the badge, then pass that number.
Until then `exclusive` stays `null`. Re-deriving variant and the content/Pilot
join are proven and untouched.

## Read-only survey tools

`scripts/probe-mse.js <host> <port>` and `scripts/probe-stomp.js <host> <port>`
dump the actor tree and the channel-state feed read-only — used to produce
`LOCAL-MSE-SURVEY.md`. Re-run them at work to confirm the live tree shape.
