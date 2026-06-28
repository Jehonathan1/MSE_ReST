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
  script. Exclusive ("בלעדי") is a separate configurable field. **Derive it from the
  normalized `texts[]`, not a padded field key** (night-61b): `getField(line2Field='1')`
  pads to `"01"`, which on 1-based Pilot content is LINE_1 — a false TWO_LINE for every
  such element. `texts[]` never holds empty strings, so `texts[1]` present+non-empty ⇒
  TWO_LINE; this mirrors viz-to-gsap's live-mapper verbatim.
- **`/state/last_taken_element` is a take CURSOR, not an on-air flag — and a cleanup
  does NOT reset it** (night-61b; KB confirms cleanup never clears last_taken). So after
  a profile/engine cleanup, drop the recorder's stale attribution bookkeeping on the
  `clear` (`_lastTakenStripeId` + each adapter's `handleClear()` → director's
  `lineToElement`/`currentActiveElementId`), or an id-less DIRECT take re-resolves to the
  now-off-air element and mirrors the previous headline before snapping. Leave
  `lastTakenPath` frozen (nulling it re-emits the off-air element as a phantom take).
- **Never fold the live MSE working copy at take-time** (night-61b): it lags ~1.4s after
  a cleanup→take and serves stale content. Read it only at settled time (the content-poll
  `_refreshMseContent`), never to attribute the take. The take-time `_reconcileLiveContent`
  is gated to a same-element re-take and disarmed across a cleanup.
- **Re-take of an edited stripe must not flash the discarded edit — resolve `last_taken`
  FRESHLY, never the frozen `lastTakenPath` (Defect 3 / "Fix C", night-62b).** Symptom: a
  stripe taken → on-air-edited → taken OFF → re-taken reloaded the original Pilot content
  but the mirror momentarily flashed the DISCARDED edit. Root cause: the take-time reconcile
  read the live working copy via the Director adapter's CACHED `lastTakenPath`, which FREEZES
  on off-air (night-61b), so on a fresh re-take it still pointed at the prior edited VCP
  working instance — surfacing the discarded edit as a spurious `change`. Fix: `_fetchMseElementData`
  now resolves `/state/last_taken_element` freshly each call (`parseLastTakenElement`) and reads
  ONLY a VCP working instance (`ref.isTemplate && ref.path`); a re-take that reloaded the saved
  Pilot element resolves to a pilotdb ref (not a template) → `{content:null}` → no stale change,
  while a genuine surviving working-copy edit is still surfaced. Also: the MSE-change detector
  keys on the ORDERED `texts[]` (`mseTextsSig`), not the field-keyed `contentSignature` — the
  live working copy ("0"/"1") and the saved Pilot element ("01"/"02") name fields differently,
  so only `texts[]` compares across the two; and the MSE baseline is **seeded from the take
  content's `texts[]`** so the FIRST on-air edit registers instead of being swallowed by the
  first working-copy read. Offline-verified 71/71; the live re-confirm of the re-take path is
  still pending (not independently re-exercised on-site).
- **A stripe SWITCH must not cross-attribute the OUTGOING element's working copy — gate the
  MSE read on the node's OWN identity (Defect 4 / night-64).** Symptom: switching to a different
  stripe (and a Line_2 edit of a freshly-switched stripe) showed wrong/old text then corrected — a
  stale flicker. Banked repro `recordings/2026-06-28T16-26-42.128Z.jsonl` seq 15→16: a fresh take
  of 2384231 (ONE_LINE) was immediately followed by an `mse` `change` carrying the OUTGOING
  2385709's on-air-edited TWO_LINE text, mislabeled onto 2384231 (even flipping its variant).
  Root cause: Fix C made `_fetchMseElementData` resolve `last_taken` freshly, but
  `last_taken`/`last_open_template` **LAGS** on a stripe→stripe switch and still names the
  OUTGOING element's VCP working copy, and the code attributed that content to the passed-in
  `elementId` under the single-occupancy assumption (it never verified the working copy BELONGS to
  `elementId`). Fix: a live element node authoritatively names itself via `<element name="…">`
  (confirmed real: `stripe-onair-edit.mse` `<element name="2380782">`, `stripe-restripe`), so
  `_fetchMseElementData` now reads that name (`parseMseElementName`) and **rejects the read
  (`{content:null}`) when it ≠ `elementId`** — the settled poll then seeds from a matching read.
  The `last_open_template` **path-segment** element/template semantics are NOT trusted (no live
  capture confirms which id it carries) — only the node's own `<element name>` is. The same guard
  fully covers the reported Line_2-change-shows-stale variant: while `last_taken` lags, every
  mismatched read is rejected; once it settles to the switched-to element, the genuine Line_2 edit
  surfaces (variant flips correctly). A node with no `<element name>` is tolerated (trusted, as
  before). Offline-verified 73/73 (fail-first FAIL on `1efee26` → PASS); live re-confirm of the
  switch path still pending (not independently re-exercised on-site).
- **A bare take-OUT (no replacement) has NO captured off-air signal at this site — do not
  guess the fix (Defect 5 / night-63, STUCK).** The banked output fixture holds only
  replacement off-airs (synthesis, same-`ts` as the next take) and cleanups (`source:engine`);
  a stripe taken out with nothing replacing it is invisible. Both plausible signals are
  already handled (director line `O`; trio active-set drop) so any offline reproduce-first
  test PASSES on HEAD — meaning the defect is a **wire/transport** reality (no `O` event
  and/or `subscribe not_implemented`; STOMP channel-state silent at this Director site), not a
  parser gap. Resolution is a **read-only live check** of which node moves on a bare OUT
  (`LM-Line_1 state/current` `O`?, `/state/last_taken_element` frozen vs inexistent?, `/state`
  `video_playout/.../element_path` clearing?, `/state/playout` / `…_slots_notifications`), then
  emit one off-air for the outgoing element WITHOUT un-freezing `lastTakenPath` and WITHOUT
  double-firing on replacement/cleanup. Full report in the issue log below.
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
- **(Stage 6b wire fixes) The two live-shoot wire gaps are TWO SEPARATE SIGNALS,
  fixed independently off-network (branch `wire-fixes-2026-06-23`).** The shoot
  (§8.5) proved a same-stripe out/in and an on-air edit touch the live MSE/engine
  through *different* channels, so they need different fixes — neither is the other.
  - **§4.1 same-stripe out/in — take detection keyed only off `last_taken_element`
    path changes** (`directorAdapter._handleLastTaken`), which **freeze** on a
    re-take to the same line, so the re-in emitted no take. The line **A/O** event
    stream (`/scheduler/*/element/*/lines/LM-Line_*/state/current`, A=on-air/O=off)
    *was* received and correctly classified as take/out by `offair.parseDirectorEvent`
    — `_handleDirectorEvent` just never **emitted** a take from an 'A'. **Fix:** emit
    a take on line state→A, attributed via `lineToElement[lineName]` (populated by the
    first take; live line frames carry `element=?`) → fallback current active element.
    The core's on-air map de-dupes the overlap with `last_taken`, so a distinct take
    is still recorded once; the OUT no longer forgets its line→element map, so the same
    line returning 'A' resolves back to the same element.
  - **§8.3 on-air edit — the content-poll re-read only the saved Pilot DB element**
    (`recorder._refreshOnAirContent → GET /dataelements/<id>`), which an on-air edit
    never writes back to (caching ruled out: byte-identical body + same etag). The
    edited text lives in the **MSE document** on the element node's `<entry
    name="data">` subnodes (API §"Live Update Support"). **Fix:** also source on-air
    content from there via **PepTalk** on the actor socket already held (`:8595`) —
    `parseMseElementData` + `directorAdapter.getNode` (read-only `get`) + a **separate
    `mseSig` baseline** that emits a `change` (`source:'mse'`) when the live signature
    moves; absent/transient live node tolerated. New content-source: **MSE element data
    subnodes**, in addition to Pilot REST.
  - **Both proven reproduce-first** (fixtures + `node --test`, classified through the
    recorder's own `offair.parseDirectorEvent` — no hand-rolled parser): each new case
    FAILS on HEAD, PASSES after. **Both still need LIVE CONFIRMATION on the next on-site
    trip** — the local rig has no live takes/content, so the wire behavior (frozen
    `last_taken`, the `<entry name="data">` shape/index base, the live `get` path) can't
    be driven here. Out of scope and untouched: the renderer/viz-to-gsap, off-air
    detection, the live-server bridge/mapping contract (keys on `type`, not `source`),
    §4.2 empty-L2 TWO_LINE labeling, §4.3 exclusive field.

- **(Issue 1 / night-59 — profile CLEANUP doesn't clear the mirrors) A profile
  cleanup is INVISIBLE on the MSE actor stream; the only read-only signal is the
  Viz Engine command console (6100).** On-site 2026-06-25 (viz-to-gsap session
  "Open Issue 4"): an operator profile/engine **cleanup** left the HE/EN/FR mirrors
  STUCK on the last on-air stripe — the recorder logged **0 lines** for it, while a
  normal take-OUT cleared all three (so the mapper→conductor path is fine; the gap
  was **detection at the recorder**).
  - **Step-0 docs (official MSE doc / KB; WebSearch was unavailable, KB-only).**
    `cleanup` is a documented **Profile Command** (`POST /profiles/<p>/cleanup`,
    rel="cleanup"; siblings: initialize/take/continue/out) — **profile-scoped, not
    element-scoped**. `/state/last_taken_element` is the *take cursor* ("the element
    handler … records the last taken element"); **nothing documents a cleanup
    clearing it** — it stays FROZEN, which is exactly why the mirrors stick.
    `playout_slots` has `clear_all(profile)` (notifications under
    `/state/playout_slots_notifications`) and the STOMP **channel state** can clear,
    but at this Director-driven site neither is populated (channelstate carries no
    `based_on`; last_taken drives takes). Engine ref confirms `RENDERER SET_OBJECT
    SCENE*x` = load, **empty `SET_OBJECT` = unload**. **Dev MSE 5.3.5 probe** (live,
    read-only): `/state/last_taken_element` is `inexistent` when nothing is taken,
    `/state/playout_slots_notifications` exists-but-empty, and an implicit
    `on_cleanup` handler + a `viz_cleanup` logic path exist but write **no
    observable `/state`** — corroborating that a cleanup leaves the MSE side silent.
  - **Root cause + detector.** The cleanup is executed MSE→engine on **6100** as
    three empty `RENDERER*<LAYER> SET_OBJECT` (unload FRONT/MAIN/BACK) + a `SCENE/
    GEOM/IMAGE/FONT/MATERIAL/MAPS CACHE CLEANUP` block — none of which touches the
    VDOM / `last_taken` / per-line A/O the recorder subscribes to, and the
    `/Cleaning up viz-handlers/` system-log line is NOT emitted at this site. So
    detection MUST read the engine console. New **opt-in** `--engine-console`
    detector: `src/recorder/engineConsole.js` (pure per-line classifier) +
    `adapters/engineConsoleAdapter.js` (CONSOLE REDIRECT + FLUSH poll + tail, read-
    only, self-owned 6100 socket) emits a `clear`; the core fans it out to off-air
    **every** on-air element (`recorder._onClearSignal`), so a tailing mirror goes
    `op=hold → op=clear` with **no mapper/live-server change**.
  - **False-positive guard.** Fires only on the cleanup-specific signal — a `…
    CLEANUP` verb OR an all-layer unload (≥2 empty `SET_OBJECT`). A normal take-out
    (one-layer clear, no CLEANUP block), a `SET_OBJECT SCENE*x` load, and the idle-
    console `failed to process command …GEOM*TYPE` flood all classify as non-clear.
  - **Reproduce-first + DEFERRED live confirmation.** Fixture
    `test/fixtures/engine-cleanup.console.txt` (the on-site block + real dev-console
    noise) drives the recorder's own classifier; `node --test` green. The pure
    classifier, the one-clear-per-block latch, and the core fan-out are offline-
    proven; the live socket/file glue was **smoke-tested read-only against the live
    engine** (connect + redirect + poll + self-correcting tail, no throw) but the
    end-to-end *take→cleanup→clear* still needs an operator-triggered cleanup. Out
    of scope & untouched: mapper/live-server/conductor (`op==='takeout'` already
    clears), translation (night 57), the red-line bug (night 58). Read-only
    throughout. **Open question for next on-site:** the raw events-mode tap
    `_cleanup-probe.js` (EVENTS, subscribes `/scheduler/*`, `/state/system/log`,
    `/state/playout`, `/state/playout_slots_notifications`) confirms whether the MSE
    emits ANY raw-but-unparsed frame on a cleanup, or truly nothing — re-confirm with
    the exact 2384347-style repro.

- **(Issue 1 / night-60 — engine-console cleanup DETECTION confirmed LIVE at home;
  self-driven, no other app, no button.)** night-59 built + offline-proved the
  detector but deferred the live end-to-end because firing a cleanup was a GUI action.
  night-60 removed that dependency with a **test-only TCP driver** (`scripts/engine-
  trigger.js`) that replicates — engine-direct over 6100 — the exact commands the MSE
  fires at the engine during a profile cleanup, run against the **live local engine
  (Viz 3.14.5.102205)**. The self-run (`scripts/night60-pipeline.js`, 13/13 PASS) drives
  the REAL `Recorder` + REAL `EngineConsoleAdapter` (real socket, real `CONSOLE
  REDIRECT` + file tail) and asserts: load → **no** false clear; a faithful cleanup →
  **exactly one** engine-sourced clear that off-airs the on-air stripe; a single-layer
  take-out → **no** over-fire; the per-element director off-air still clears. A
  viz-to-gsap **live-server** mirror over the JSONL (decoupled — JSONL + HTTP only)
  goes **op=hold → op=clear** (`scripts/night60-mirror-capture.js`, 4/4 PASS). Evidence
  archived under `test/fixtures/live/night60/` (`RUN.md` + console excerpt + driver
  command logs + JSONL + mirror state).
  - **REAL vs SEEDED (honest).** REAL: the engine-console cleanup **detection** leg —
    the night-59 deferred thing, now live. SEEDED: the MSE **take** (a live MSE take +
    Pilot content are work-only on the bare rig, so the actor/STOMP legs are stubbed and
    the on-air element is injected via the recorder's own `_onTakeSignal`). **Still
    on-site only:** an MSE-driven take + an MSE-driven (`rel="cleanup"`) profile cleanup
    against a populated profile.
  - **The home rig needs two engine settings the on-site broadcast engine has standing
    (Viz External Commands Manual).** `MAIN SHOW_COMMANDS ON` makes the engine echo
    received commands to the console (without it, `CONSOLE REDIRECT` captures only
    `JOINING/LEAVING SESSION` — the cleanup is invisible); `MAIN SWITCH_EXTERNAL ON`
    puts it in on-air/control mode so `SET_OBJECT`/CLEANUP **execute** (else
    `ERROR … the command is not allowed in this mode`). The **driver** sets these (and
    restores OFF after); the recorder never does — it stays read-only.
  - **Live console format ≠ the on-site fixture (locked in).** The live engine echoes
    commands **wrapped**: `…(TCP): receive <0 SCENE CLEANUP>`, not the bare `SCENE
    CLEANUP` of `engine-cleanup.console.txt`. The classifier still latches one clear
    through the wrapper (the CLEANUP verb is a substring match); the bare-only all-layer-
    unload heuristic is not needed (every real cleanup carries the CACHE CLEANUP block).
    Deliberately **not** hardened to strip the wrapper — the engine's own `GUI: receive
    <… SET_OBJECT >` layer clears during the on-air switch would then risk a false
    all-layer-unload. New fixture `test/fixtures/engine-cleanup.wrapped.console.txt` +
    `test/engine-trigger.test.js` guard both the driver command shapes and the wrapped
    format. Read-only throughout; no recorder write path, no MSE POST, no mapper/live-
    server/conductor change.

- **(Defect 1 / night-61b — a cleanup doesn't reset the take cursor, so a direct
  post-cleanup take mirrored the PREVIOUS headline).** On-site 2026-06-28
  (viz-to-gsap `convergence/ONSITE-FINDINGS-2026-06-28.md`): after a profile/engine
  cleanup, taking an element **DIRECTLY** (no playlist initialize) mirrored the
  previous headline, then snapped to the right one a frame later. **Root cause:** the
  actor's `/state/last_taken_element` is a take **cursor**, NOT an on-air flag, and a
  cleanup does **not** reset it (KB: cleanup never clears last_taken — this confirms
  it). So the next id-less line take resolved to the now-off-air element through the
  recorder's stale bookkeeping (the director adapter's `lineToElement` /
  `currentActiveElementId`, and the core's `_lastTakenStripeId` re-take cursor) instead
  of re-resolving from the authoritative last_taken read.
  - **Fix (read-only, recorder-side only — no write/POST path).** On a `clear`,
    `recorder._onClearSignal` now nulls `_lastTakenStripeId` and calls
    `adapter.handleClear()` on every adapter; `directorAdapter.handleClear()` drops
    `currentActiveElementId` + `lineToElement`. `lastTakenPath` is left **frozen** on
    purpose — nulling it would let the next streamed/polled last_taken (still naming
    the off-air element) re-emit it as a **phantom** take. With the maps cleared, an
    id-less direct take falls through to the on-demand `get /state/last_taken_element`,
    which a direct take has advanced to the actually-taken element.
  - **Reverted misstep (do NOT redo).** Folding the live MSE working copy **at
    take-time** is wrong: it lags ~1.4s after a cleanup→take and serves stale content.
    Read it only at **settled** time (the content-poll), never to attribute the take.
    EDIT 1's `_lastTakenStripeId = null` also disarms the same-element re-take reconcile
    (`_reconcileLiveContent`) for the post-cleanup re-take, so the lagging copy is not
    read at take-time.
  - **Defect 2 mirror.** `deriveVariant` now derives 1-line/2-line from the normalized
    `texts[]` (a verbatim mirror of viz-to-gsap's live-mapper), not a padded field key:
    `getField(line2Field='1')` pads to `"01"`, which on **1-based** Pilot content is
    LINE_1 — mislabelling every such element TWO_LINE. `texts[]` never holds empty
    strings, so `texts[1]` present+non-empty ⇒ TWO_LINE. The `getField` fallback stays
    for content carrying `fields` but no `texts`.
  - **Reproduce-first.** Three tests FAIL on `57a4f45` → PASS after the edits: id-less
    direct take after a cleanup attributes to the just-taken element (not the frozen
    cursor); the post-cleanup same-stripe re-take does NOT read/fold the lagging working
    copy at take-time; `deriveVariant` on 1-based content with an empty Line_2 returns
    ONE_LINE. `node --test` 69/69 green. Out of scope & untouched: viz-to-gsap (that's
    61A), engine/MSE writes, the mapper/live-server contract.

- **(Defect 3 / "Fix C" / night-62b — a re-take of an edited stripe flashed the
  DISCARDED edit).** On-site 2026-06-28 evening
  (`ONSITE-FINDINGS-2026-06-28-evening.md`): a stripe taken → on-air-edited → taken OFF
  → **re-taken** reloaded the original Pilot content, but the mirror momentarily flashed
  the discarded edit. **Root cause:** the take-time reconcile read the live working copy
  via the Director adapter's CACHED `lastTakenPath`, which FREEZES on off-air (night-61b),
  so on a fresh re-take it still pointed at the prior edited VCP working instance —
  surfacing the discarded edit as a spurious `change`.
  - **Fix (read-only, recorder-side only — no write/POST path).** `_fetchMseElementData`
    now resolves `/state/last_taken_element` **freshly** each call (`parseLastTakenElement`)
    and reads ONLY a VCP working instance (`ref.isTemplate && ref.path`); a re-take that
    reloaded the saved Pilot element resolves to a pilotdb ref (not a template) →
    `{content:null}` → no stale change, while a genuine surviving working-copy edit is still
    surfaced. The MSE-change detector now keys on the ORDERED `texts[]` (`mseTextsSig`), not
    the field-keyed `contentSignature` (live "0"/"1" vs Pilot "01"/"02" name fields
    differently — only `texts[]` compares across the two), and the MSE baseline is **seeded
    from the take content's `texts[]`** so the FIRST on-air edit registers instead of being
    swallowed by the first working-copy read.
  - **Reproduce-first.** Two tests FAIL on `0b1503e` → PASS after: a discarded-edit re-take
    emits NO stale change and never reads the frozen stale VCP node; a genuine surviving VCP
    working-copy edit IS still surfaced. `node --test` 71/71 green.
  - **Live re-confirm still pending** — the re-take path was offline-verified (71/71) but
    not independently re-exercised on-site; flag it for the next live trip. Out of scope &
    untouched: Defects 4 & 5 (separate prompts), the live-server/conductor, viz-to-gsap.

- **(Defect 4 / night-64 — a stripe SWITCH cross-attributed the OUTGOING element's stale
  working copy).** On-site 2026-06-28: switching to a different stripe (and a Line_2 edit of a
  freshly-switched stripe) showed wrong/old text, then corrected — a stale flicker. Banked repro
  `recordings/2026-06-28T16-26-42.128Z.jsonl` seq 15→16: a fresh take of `2384231` (ONE_LINE,
  `["מפקד סנטקום יגיע לישראל"]`) was immediately followed by an `mse` `change` attributed to
  `2384231` but carrying the PREVIOUS `2385709`'s on-air-edited TWO_LINE text
  (`["…לבנון השלישית","…"]`), even flipping its variant to TWO_LINE.
  - **Root cause.** Fix C made `_fetchMseElementData` resolve `last_taken` freshly and read the
    VCP working instance, but it then attributed that content to the passed-in `elementId` under
    the single-occupancy assumption — it never verified the working copy BELONGS to `elementId`.
    On a stripe→stripe switch `last_taken` / `last_open_template` **lags** and still names the
    OUTGOING element's working copy, so the content poll read `2385709`'s edit and mislabeled it
    as `2384231`.
  - **Fix (read-only, recorder-side only — no write/POST path).** A live element node
    authoritatively names itself via `<element name="…">` (confirmed real:
    `stripe-onair-edit.mse` `<element name="2380782">`, `stripe-restripe`). New
    `parseMseElementName(xml)` reads that name; `_fetchMseElementData` now **rejects the read
    (`{content:null}`) when the node-name ≠ `elementId`**, so the settled poll seeds from a
    matching read instead of cross-attributing. The `last_open_template` path-segment
    element/template semantics are deliberately NOT trusted (no live capture confirms which id it
    carries) — only the node's own `<element name>` is. A node with no `<element name>` is
    tolerated (trusted, as before). This also fixes a latent multi-occupancy mis-read (the single
    global `last_taken` could only ever name one element's working copy; others now correctly
    return null rather than inherit it).
  - **Reproduce-first.** Two tests FAIL on `1efee26` → PASS after: a switch where `last_taken`
    lags to the OUTGOING element is rejected (`{content:null}`) and emits no stale change; a
    genuine Line_2 edit on the CURRENT element (node-name matches) IS still surfaced (variant
    flips to TWO_LINE). `node --test` 73/73 green. The **Line_2-change-shows-stale** variant is
    covered by the same guard (no separate case needed): while `last_taken` lags every mismatched
    read is rejected; once it settles the genuine edit surfaces.
  - **Live re-confirm still pending** — offline-verified only; the switch path was not
    independently re-exercised on-site. Out of scope & untouched: Defect 5, the cleanup path,
    viz-to-gsap.

- **(Defect 5 / night-63 — a bare take-OUT leaves the mirror STUCK) — STUCK-REPORT, no fix
  landed: the bare-OUT signal cannot be confirmed offline, so per PROMPT C + CLAUDE.md the
  fix is deferred to a read-only live check rather than guessed.** Symptom (on-site
  2026-06-28): a stripe taken **OUT** with nothing replacing it stays on the mirror; it
  only clears when the operator takes a DIFFERENT stripe (a replacement) or fires a cleanup.
  - **Why it cannot be reproduced offline (the blocker).** The banked fixture
    `recordings/2026-06-28T16-26-42.128Z.jsonl` is the recorder's **output**, and it
    contains **no bare-OUT instance**: every `off-air` is either `source:engine` (a cleanup
    — seq 5, seq 19) or a `source:director` off-air at the **exact same `ts`** as the
    following `take` (seq 7/8, 9/10, 11/12, 14/15, 17/18) — the millisecond-identical
    signature of the core's **single-occupancy synthesis** in `_onTakeSignal`, NOT a real
    OUT event. The operator never took a stripe out *without* an immediate replacement (or a
    cleanup) during this capture, so the symptom's triggering event was never recorded.
  - **No raw feed exists to characterize the bare OUT.** `recordings/director/*.jsonl` are
    older recorder **outputs**, not raw actor/STOMP taps. There is no raw `/scheduler` A/O,
    `/state/playout`, or `/feeds/channelstate` capture of the June-28 session — so the
    bare-OUT wire shape cannot be reconstructed from committed data.
  - **The two plausible bare-OUT signals are ALREADY handled by tested code — a
    reproduce-first test for either PASSES on HEAD (it cannot FAIL-first).**
    (a) `directorAdapter` emits `off-air` on a line `set …/LM-Line_*/state/current O`
    (`recorder.test.js` "take via last_taken, then an out…", "off-air does NOT depend on the
    channel name"); (b) `trioAdapter` emits `off-air` when an element drops from the
    channel-state active set (`recorder.test.js` "TrioAdapter emits normalized take/off-air",
    "one off-air, not two"). The real defect is therefore **not** a parsing gap — it is that
    **neither signal reaches the recorder on the wire at this site**, a transport reality not
    reproducible from fixtures.
  - **Prior art rules out the prompt's suggested "channel empties" fix at THIS site.** STOMP
    channel-state is **silent under the Director path at i24** ("expected, not a bug" — see
    the Stage-1/2c lessons above: the global feed carries no `based_on`, `last_taken` drives
    takes). So deriving the bare-OUT off-air "from the channel-state going empty" is a no-op
    here — the empty frame never arrives. And on a **same-line replacement** the single
    `LM-Line_1` goes **A→A** (no `O`), which is *why* the core synthesizes the replacement
    off-air; a bare OUT *should* drive that one line **A→O**, which `directorAdapter` already
    handles **iff the VDOM event is delivered**. The on-site report that actor `subscribe`
    returned `not_implemented` (which would suppress ALL external A/O VDOM events, leaving
    takes to come from the `last_taken` poll and outs to come ONLY from synthesis + cleanup)
    is the leading hypothesis but is **not decidable from the captured output** alone.
  - **Read-only live check for the next on-site trip (name the exact nodes/fields).** Do a
    deliberate **bare OUT** (take one stripe, then OUT with nothing replacing) while a
    read-only events+poll tap (e.g. `scripts/probe-mse.js` / the `_cleanup-probe.js` events
    tap) records which of these moves:
    1. `/scheduler/*/element/*/lines/LM-Line_1/state/current` — does a `set`/`replace`/
       `delete` carrying **`O`** arrive on the bare OUT? If YES → `directorAdapter` already
       parses it and the true bug is that **VDOM events aren't being received** (the
       `subscribe … not_implemented` lead) → fix is at negotiation/subscription, not parsing.
       If NO event arrives → VDOM is confirmed silent for OUTs.
    2. `/state/last_taken_element` — after the bare OUT, does it go `error inexistent` / change,
       or stay **FROZEN** on the outgoing element? (Poll before/after.) An inexistent/empty
       transition is a poll-detectable bare-OUT signal that does **not** require un-freezing
       `lastTakenPath` (preserves the night-61b phantom-take guard).
    3. `/state` → `video_playout/viz_video/channels/<n>/element_path` (+ status
       `stopped`/playing) — LOCAL-MSE-SURVEY §3 shows `/state` carries the on-air
       `element_path` and a channel status; `directorAdapter` **already polls `get /state`
       every 2s but discards the reply**. If `element_path` clears / status → `stopped` on a
       bare OUT, this is the cleanest poll-based detector.
    4. `/state/playout` (already SUBSCRIBED, never parsed) and
       `/state/playout_slots_notifications` — does either emit a frame / go empty on the OUT?
    5. STOMP `/feeds/channelstate` — re-confirm whether it stays silent (expected) or the
       active set actually empties (only then is the channel-empty fix viable).
  - **Then the fix (deferred until one node above is confirmed):** parse whichever node
    demonstrably transitions on the bare OUT and emit **one** `off-air` for the outgoing
    element — WITHOUT un-freezing `lastTakenPath` (night-61b), WITHOUT double-firing on a
    normal replacement (already off-aired by synthesis) or a cleanup (already fanned out by
    `_onClearSignal`). Reproduce-first becomes possible once a real bare-OUT frame (or a raw
    tap of one) is banked as a fixture. Out of scope & untouched: Defect 4, Fix C internals,
    viz-to-gsap. **No code changed in night-63 — investigation + this report only.**
  - **UPDATE (night-64, new capture `recordings/2026-06-28T14-57-06.517Z.jsonl`, 89 events
    seq 0–88) — a real director bare-OUT IS now banked, and it confirms the diagnosis:
    transport/coverage gap, not a parser bug.**
    - **(a) Evidence — the director adapter DOES emit a bare-OUT `off-air` when `/state/current`
      O arrives.** Seq 70 is a `source:director` `off-air` of element `2385709` at
      `16:10:20.581Z` that is **standalone, not replacement-synthesized**: it carries its own
      `ts`, and the next event (seq 71) is a **re-take of the SAME element `2385709` 3701 ms
      later** — not the millisecond-identical, different-element pairing that marks the core's
      single-occupancy synthesis. Surrounding shape: seq 67 take `2385709` → seq 68/69
      `source:mse` `change` (working-copy edits) → **seq 70 director bare-OUT** → seq 71 re-take.
      The operator took the stripe OUT with nothing replacing it, the screen cleared for ~3.7 s,
      then re-took. Every OTHER standalone clear in this capture is `source:engine` (9 of them:
      seq 5, 11, 13, 15, 43, 49, 66, 73, 88 — engine-console cleanups/clears, not director OUTs);
      the only other "exact-ts standalone" director off-air, seq 9, is a 1 ms-adjacent
      replacement of a *different* element (`2384231`→`2381258`), i.e. synthesis jitter, not a
      bare OUT. **Conclusion:** when the director VDOM `O` is delivered, the bare-OUT is captured
      correctly — the parser is sound (`test/fixtures/stripe-takeout.actor.json` already PASSES
      on HEAD; it cannot FAIL-first). The STUCK symptom is therefore a **transport/coverage gap**
      — it surfaces only when that director `O` does NOT reach the recorder (the
      `subscribe … not_implemented` lead, or any run whose active source has no bare-OUT signal,
      e.g. an engine-console-only deployment) — **not** a defect in `offair.js`/`directorAdapter`.
    - **(b) Candidate FIX SHAPE — an engine-console single-layer-unload fallback.** When the
      director `O` never arrives, the Viz Engine *still* unloads the stripe's LM layer on a bare
      OUT (a **single-layer** unload — one empty `SET_OBJECT` for the LM layer), distinct from a
      profile **cleanup** (all-layer unload + `… CLEANUP` block, already classified by
      `engineConsole.js` and fanned out via `_onClearSignal`). The fix: have
      `engineConsoleAdapter` (already tailing 6100 when `--engine-console` is set) classify a
      lone single-layer LM unload and emit **one** `off-air` for the element on that layer —
      **de-duped against a director (or trio) `off-air` for the same element within a short
      window** so it never double-fires on (i) a hot-swap/replacement (the outgoing element is
      already off-aired by synthesis and the engine swap is a layer A→A, not an unload), or (ii)
      a cleanup (already an all-layer unload + CLEANUP that `_onClearSignal` owns). This keeps
      `lastTakenPath` frozen (preserves the night-61b phantom-take guard) and adds a SECOND,
      transport-independent path to the bare-OUT off-air that does not depend on the director
      VDOM `O` being delivered — closing the coverage gap that leaves the mirror STUCK.
    - **(c) Sharpened on-site ask — bank the RAW engine-console bare-OUT signature.** Step 5 of
      the read-only live check is now the priority: with the `--engine-console` tail (6100)
      recording, do a deliberate **bare OUT** — take one stripe, then OUT with **nothing
      replacing it and NO cleanup** — and capture the RAW engine-console lines for that OUT. The
      goal is the exact **single-layer LM unload signature** (which layer string, the empty
      `SET_OBJECT` shape, and confirmation that NO `CLEANUP` block accompanies it) so the (b)
      fallback can be built reproduce-first: that raw line becomes the fixture that FAILs on HEAD
      (no off-air emitted) → PASSes after the engineConsoleAdapter learns the single-layer
      unload. Without this raw signature the fallback is still a guess; with it, it is testable
      offline. **Still no code changed — night-64 enriches the report only.**

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
- `src/recorder/` — `recorder.js` (core: connections + join + JSONL + `_onClearSignal` cleanup fan-out), `parsers.js` (shared parse/derive), `offair.js` (official PepTalk five-verb OUT classifier + KB fallbacks), `engineConsole.js` (pure Viz-Engine-console cleanup classifier — issue 1), `recorderConfig.js`
- `src/recorder/adapters/` — detection-adapter interface: `directorAdapter.js` (actor; begin-framing + line-name cross-ref), `trioAdapter.js` (STOMP; channel-state + watchdog), `engineConsoleAdapter.js` (opt-in `--engine-console` 6100 clear detector — issue 1), `index.js` (`buildAdapters` by `--source` + opt-in engine console)
- `_cleanup-probe.js` — read-only raw events-mode PepTalk tap for the profile-cleanup open question (issue 1)
- `test/` — regression suite + committed Stripe-lifecycle fixtures
- `scripts/probe-mse.js` / `scripts/probe-stomp.js` — read-only survey probes
- `scripts/engine-trigger.js` — **test-only** TCP driver for the LOCAL Viz Engine (6100): replicates the MSE's cleanup command shapes (load/unload/take-out/cleanup + read-only probe/list + rig-setup show-commands/external). Loopback-guarded; the recorder gains no write path (issue 1 / night-60)
- `scripts/night60-pipeline.js` / `scripts/night60-mirror-capture.js` / `scripts/night60-console-probe.js` — the self-run harnesses that prove the engine-console cleanup detection LIVE (recorder+driver asserts; live-server mirror op=hold→op=clear; transport de-risk). Evidence under `test/fixtures/live/night60/`
- `LOCAL-MSE-SURVEY.md` — local MSE tree map + "confirm at work" checklist
- `RECORDER.md` — recorder/replay usage, config, JSONL schema
- `src/server/index.js` — legacy HTTP + STOMP/WebSocket monitor bridge
- `src/server/websocket/` — STOMP frame handlers (connection logic the recorder reuses)
- `STREAMDECK.md` — Elgato StreamDeck button setup
