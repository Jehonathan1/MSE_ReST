# Local Media Sequencer Survey — Stage 1 (rehearsal rig)

**Date:** 2026-06-16
**Host:** `127.0.0.1` (laptop "VizrtDep") — Media Sequencer **5.3.5.23063**
**Method:** read-only only. REST `GET` on 8580, PepTalk `protocol`+`get` on 8595, STOMP `CONNECT`+`SUBSCRIBE` on 8582, and reading the on-disk persisted document. **Nothing was taken, cued, cleared, or POSTed.**
**Tooling (committed, reusable at work):** `scripts/probe-mse.js` (actor tree dump), `scripts/probe-stomp.js` (channel-state feed).

> **Headline:** the laptop MSE is a **bare rig** — engine + all handlers loaded and every port reachable, but **no profile, no channel, no show, no Pilot/Gateway mount are currently configured.** All three transport legs handshake against the real MSE (this is what the rig proves), but there is **no live channel and no observable take at home.** The `Yonathan` / `Awesome localhost` / template `16082` names baked into the old code are **stale** — they 404 / are absent on the current document. Treat every name and ID as work-only (see checklist at the bottom).

---

## 1. Port reachability (127.0.0.1)

| Port | Purpose | Transport | Reachable | Notes |
|---|---|---|---|---|
| **8580** | MSE REST (Atom Publishing) | HTTP | ✅ | Service doc + collections. |
| **8581** | STOMP server / channel-state ws (internal) | — | ✅ (listening) | Internal `local_port`; clients use 8582. |
| **8582** | STOMP channel-state feed | WebSocket | ✅ | `CONNECT`/`SUBSCRIBE` proven. |
| **8594** | PepTalk (treetalk) | TCP | ✅ | Internal PepTalk port. |
| **8595** | PepTalk **actor** | WebSocket | ✅ | `protocol`+`get` proven. This is what the recorder uses. |
| **8177** | **Pilot Data Server** | HTTP | ❌ | **Not listening — expected.** No Pilot on the laptop; the content leg is **work-only**, not a bug. See §6. |

Port wiring confirmed from the persisted document (`C:\ProgramData\Vizrt\Media Sequencer\default.xml`):
`http_server` → 8580, `treetalk` → 8594, `peptalk_websocket` local 8594 / **opened 8595**, `channel_state_websocket` local 8581 / **opened 8582** (opcode **binary**), `stomp_server` opened 8581. These match `config/config.js` exactly (`MSE_WEBSOCKET_PORT 8595`, `STOMP_PORT 8582`, REST 8580).

---

## 2. MSE REST tree (8580) — structure map

`GET /` returns an APP service document. Collections:

```
http://127.0.0.1:8580/
├── /profiles            (profile collection)      ← EMPTY feed (no profiles)
├── /directory/          (directory collection)    ← EMPTY feed (no shows)
├── /default-templates
├── /settings
├── /actions
├── /webapps
└── /element_schedules
```

- `GET /profiles` → Atom feed with **zero `<entry>`**.
- `GET /profiles/Yonathan` → **404 Not Found** (the configured name does not exist here).
- `GET /directory/` → empty Atom feed (no shows / playlists).

The full element/VDOM mount points are visible under `/config` (actor): `profile_collection id="profiles"`, `element_collection`, `template_collection`, `show`, `ec_directory id="directory"`, `output`, etc. — the handlers exist, but the data entries they expose are empty.

> At **work**, a configured MSE exposes the per-profile content here, e.g. `GET /profiles/<ProfileName>` and `GET /profiles/<ProfileName>/state` (the recorder's `fetchProfileEngines` / `fetchChannelName` paths). Pilot elements appear under `/external/pilotdb/elements/<id>` once the Gateway/Pilot link is up.

---

## 3. PepTalk actor tree (8595) — ground truth

Protocol negotiated cleanly: server replied
`protocol peptalk noevents pretty prettycolors uri xmlscheduling`
(the recorder requests `peptalk noevents uri` — a subset, fully supported). **The actor take leg connects and answers `get` against the real MSE.**

| `get` path | Result | Meaning |
|---|---|---|
| `/` | ok (4 KB+ handler dump) | Scheduler + all handlers loaded. |
| `/config` | ok | REST handler mounts (`profile_collection`, `element_collection`, `template_collection`, `show`, `ec_directory`…). |
| `/config/profiles` | ok, **empty** (`<entry name="profiles"/>`) | **No profiles configured.** |
| `/state` | ok | `playout_slots_notifications` empty; `video_playout/viz_video/channels/1` = **`stopped`**, no `element_path`. |
| `/state/last_taken_element` | **`error inexistent`** | The take marker node does **not exist** until a profile is active and something is taken. |
| `/storage` | **`error inexistent`** | No Trio show storage. |
| `/external` | **`error inexistent`** | **No `/external/pilotdb/...` mount** → no Pilot/Gateway link locally. |
| `/directory` | ok, **empty** | No shows. |

The persisted doc also carries a standing error: *"Actions very delayed. Reinitialize recommended."* — consistent with an idle/long-running rig; not relevant to read-only probing.

---

## 4. How on-air / transition-logic state is represented

The handlers that produce the on-air state feed **are present and wired**:
`channel_state`, `channel_state_monitor` (→ `channel_state_handler: channel_state`, `stomp_server_handler: stomp_server`). So the machinery the recorder depends on exists — it just has no channel to report on right now.

**The structure `stompClient.js`/`websocketServer.js` parse** (the assumption to ground-truth) is, per the working code and the channel-state feed:

```
<feed>
  <entry>
    <title>{channelName}</title>                         ← e.g. "Awesome localhost"
    <content>
      <state:channel>
        <state:layer name="middle" type="transition_logic">
          <state:transition_logic_layer based_on="…">    ← one per active element
          …
```

On-air detection = presence of a `state:transition_logic_layer` whose `based_on` resolves to an element/template; **off-air = that element dropping out of the active set** between frames. The `based_on` reference takes one of two shapes:

- Pilot element: `…/pilotdb/elements/<id>` → captured by `/\/pilotdb\/elements\/(\d+)/` → **element id**.
- Template:       `…/<id>/dataitems/last_open_template` → captured by `/\/(\d+)\/dataitems\/last_open_template/` → **template id**.

> **Status of this assumption:** the code path was **verified historically** on this machine (git log: "Getting STOMP Data Successfuly", "Monitoring Off-Air successfuly") when a profile/channel was configured. It **cannot be re-verified on the current bare rig** — `/feeds/channelstate` returns **0 frames** (no channel exists to emit state). The XML shape above is therefore taken from the proven code, and the live `state:` document **must be re-confirmed at work** against a populated channel (see checklist). The synthetic fixture (`test/fixtures/`) encodes this exact shape so the parser is regression-tested offline.

---

## 5. Shows / playlists / elements / templates, and what an element reference looks like

- **Locally: none.** `/directory/` and `/storage` are empty/inexistent; no shows, playlists, elements, or templates are present to enumerate.
- **The element reference shapes the recorder keys off** (to be matched at work):
  - **State feed** `based_on` → `/pilotdb/elements/<id>` (element) or `/<id>/dataitems/last_open_template` (template).
  - **Actor** `get /state/last_taken_element` → `<entry name="path">…</entry>` containing either `…/external/pilotdb/elements/<id>` or `…/dataitems/last_open_template/<id>`.
  - **Pilot REST** `GET /dataelements/<id>` (Accept `application/atom+xml;type=entry`) → `<link rel="template" href="…/templates/<templateId>">`, `<title>`, and `<field name="0|1|…"><value>…</value></field>` numeric fields → these are the **Line_1 / Line_2** strings. The Stripe is identified by its **template id** (the old hard-coded `16082` — do not trust it; record the real one).

---

## 6. Pilot reachability — confirmed work-only

`8177` is **not listening** locally (TCP connect fails) **and** the actor has **no `/external` mount**, so even the element references that would point into Pilot are absent. This is the **expected** rehearsal-rig condition: there is no Pilot Data Server at home. The recorder therefore must (and does) record takes with `content: null` + `contentPending: true` + the unresolved element reference whenever the Pilot host is unset/unreachable — so the same binary runs clean at home and fills content in at work. **This is a known work-only step, not a defect.**

---

## 7. Is a take observable locally?

**No.** Root cause is the same bare-rig condition: no profile, no channel bound to an engine, `video_playout` channel `stopped`, `/state/last_taken_element` inexistent, `/feeds/channelstate` silent. What **is** proven end-to-end at home:

- ✅ **STOMP leg** — `CONNECT` + `SUBSCRIBE /feeds/channelstate` succeed against the real MSE.
- ✅ **Actor/PepTalk leg** — `protocol` negotiation + `get /state` succeed against the real MSE.
- ⛔ **A real on-air take** — not exercisable at home (no live channel). Deferred to the office, exactly as the capture plan assumes.

So Stage 1 proves *connectivity + parsing code (via fixture)*; the office trip provides the *live take + Pilot content*.

---

## 8. What to confirm at work (the deltas)

Names/IDs first — **everything below is unknown or stale locally:**

- [ ] **Profile name** — real value (local `/config/profiles` is empty; `Yonathan` 404s). Get from MSE web UI → profiles or the operator. Set `PROFILE_NAME`.
- [ ] **Channel name** — real value (local default `Awesome localhost` is unverifiable). Set `CHANNEL_NAME`. It appears as the channel-state `<entry><title>`.
- [ ] **Work Pilot host/IP** — `config.js` points at `8.217.136.41:8177`; **verify the office Pilot IP/port** and set `PILOT_HOST`. A wrong host is the single most likely capture failure.
- [ ] **Stripe template id** — the real one (NOT local `16082`). Note it when a Stripe goes on air. Set `TARGET_TEMPLATE_ID` / `--stripe-template`.
- [ ] **Stripe element id(s)** — the `/pilotdb/elements/<id>` the Stripe uses; record each observed.

Connectivity / structure to re-confirm against a **populated** channel:

- [ ] STOMP `8582`, actor `8595`/REST `8580`, **Pilot `8177`** all reachable read-only from the work laptop.
- [ ] **Live channel-state XML matches §4** — `state:channel` → `state:layer name="middle" type="transition_logic"` → `state:transition_logic_layer` with `based_on`. Confirm the element vs. template `based_on` shapes.
- [ ] `get /state/last_taken_element` returns a real `<entry name="path">` on a take (it exists once a profile is active).
- [ ] `GET /dataelements/<id>` returns `fields{}` with numeric `0,1,…` (Line_1 / Line_2) and a `template` link → template id. **Confirm which numeric field is Line_1 vs Line_2** (drives the 1-line/2-line variant).
- [ ] Spot-check the JSONL during the capture: take events carry **non-empty** Pilot `fields` for the noted element ids (if empty → wrong Pilot host).

---

### Reproduce this survey

```powershell
# Ports
foreach ($p in 8580,8582,8594,8595,8177) { "$p: $((Test-NetConnection 127.0.0.1 -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded)" }
# REST tree
Invoke-WebRequest "http://127.0.0.1:8580/" -UseBasicParsing | Select -Expand Content
# Actor tree (read-only)
node scripts/probe-mse.js 127.0.0.1 8595
# STOMP channel-state feed (read-only)
node scripts/probe-stomp.js 127.0.0.1 8582
```
