# mse-viewer — project conventions (read this first)

Inherits `Desktop/CLAUDE.md` + `Desktop/VIZ-PROJECTS/CLAUDE.md`. This file is the project-specific layer.

**What this is:** a **read-only** watcher/recorder of live Vizrt MSE on-air activity. It captures the
on-air Stripe lifecycle to replayable JSONL, joins element content from Pilot, and hands a normalized
event stream to the `viz-to-gsap` convergence bridge. It also includes the legacy Express data-viewer
(`src/server/`) and StreamDeck control glue. Pair project: `../viz-to-gsap` (the recreation + verifier).

## The cardinal rule — READ-ONLY toward live infrastructure

The recorder only **SUBSCRIBEs** (STOMP), **gets** (PepTalk actor), and **GETs** (Pilot/MSE REST).
There is **no take / cue / clear / POST path**, by design, so it is safe to run against a live show.
Never add a write/POST/SET path to the recorder. Against the **production** MSE/Pilot/engine, stay
read-only, full stop. (The `.claude` perms enforce this — POST/PUT/DELETE are denied.) Writing to your
**local dev** MSE/engine is fine for tests, but do it from a *separate* client, not the recorder.

## Architecture (so you know which port carries what)

Three layers, do not conflate them:
1. **Operator clients** — Viz Director / Trio / Pilot, and Yehonatan's own `../viz-engine-gui` and
   `../mcr-controller`. These are just UIs that send commands; none is required to drive anything.
2. **Media Sequencer (MSE)** — the orchestrator. REST **8580**, PepTalk actor/events **8595**, STOMP
   channel-state **8582**. Profile commands (take / cleanup / initialize / continue / out) are atom
   links (`rel="cleanup"` → `POST /profiles/<profile>/cleanup`). The MSE translates these into engine
   commands.
3. **Viz Engine** — the renderer, command port **6100**. `SET_OBJECT SCENE*x` = load; empty
   `SET_OBJECT` = unload; `… CLEANUP` = free memory.

**Pilot Data Server (8177)** is the **content store** (the actual text/field payloads). The on-air feed
carries only an element *reference*; the recorder fetches the text from Pilot on each take. Pilot is
irrelevant to clearing/cleanup — it only matters when you need real content.

## Detection design (the heart of the recorder)

On-air detection is normalized behind **adapters** (`src/recorder/adapters/`): **Director = PepTalk
actor (8595)**, **Trio = STOMP channel-state (8582)**. The **core** (`src/recorder/recorder.js`) owns
the connections, the Pilot join, variant/exclusive derivation, the on-air map, and the JSONL writer;
adapters only DETECT and emit normalized `take`/`off-air` tagged with their `source`. `--source
director|trio|auto` (default `auto`; the on-air map de-dupes overlaps). Events must be enabled
(`protocol peptalk events`, not `noevents`). The **official MSE "document and API"** PepTalk event
model (verbs delete/insert/move/replace/set) is the authority — where a branch heuristic and the doc
disagree, the doc wins. `1-line vs 2-line = is Line_2 empty?`.

**Cleanup detection (issue 1 / night-59):** a profile cleanup is NOT seen on the actor/STOMP streams —
it runs MSE→engine on **6100** as an all-layer unload + `… CLEANUP` block. The opt-in
`--engine-console` tail (`src/recorder/engineConsole.js` + `adapters/engineConsoleAdapter.js`)
classifies it and fans a clear out to off-air. **`--engine-console` is a boolean flag**; the engine
port is the *separate* `--engine-port` (default 6100). Write `--engine-console` (optionally
`--engine-port 6100`) — **never `--engine-console 6100`**, which binds `6100` as the flag's value, so
the config check (`=== true || === 'true'`) fails and the detector silently stays off.
Triggering a cleanup for a test does NOT need Viz
Director — use Yehonatan's own clients: **`../mcr-controller`** fires the MSE profile cleanup
(production-faithful; the recorder sees it because it watches the MSE), **`../viz-engine-gui`** loads a
scene and fires the engine memory-cleanup on 6100 (its built-in cleanup is the CLEANUP block only — add
an empty `SET_OBJECT` for the layer-unload). Keep Claude read-only; the human presses the button.

## Workflow + conventions

- **C / E split.** `C:\…\mse-viewer` is **canonical**; `E:\mse-viewer` is the testing clone. Convention
  is **commit on E, then ff-promote to C** (`--ff-only`). If you commit on C directly, flag it so E can
  be synced to keep promotions clean. See the promote/mainsync doc if present.
- **NEVER `git push` to origin** — that is Yehonatan's to do by hand (the `.claude` perms deny push).
- **Tests:** `node --test` (a.k.a. `npm test`). **Reproduce-first / fixture-per-signal** — a single
  happy-path fixture is not coverage; each detection signal gets its own fixture. Gate FAIL-on-HEAD →
  PASS for any new detector.
- **Bare-rig caveat:** the local dev MSE handshakes on all legs but has empty profiles, no channel, and
  Pilot down (`LOCAL-MSE-SURVEY.md`) — a live take + real content are **work-only**. Cleanup/engine
  tests can still run locally via the engine (`viz-engine-gui`). The recorder keeps its own config
  resolver; pass `--mse-host 127.0.0.1` locally (the repo `.env` `MSE_HOST` is a work URL).
- **Stuck protocol:** if 3 research-backed hypotheses fail on the same mismatch, stop and write a
  stuck-report in PROJECT.md rather than landing an unverified fix.

## Contract with viz-to-gsap (keep the repos SEPARATE)

The only interface is the **normalized event-stream JSONL** (`take`/`change`/`off-air`/`session`,
`source`, `content.fields`). viz-to-gsap's `convergence/live-server.js` is the consumer. Do not merge
the repos — the loose coupling keeps the recorder provably read-only.

## Read before editing

`PROJECT.md` (frontmatter + the rich `## Lessons`), `RECORDER.md` (streams, adapters, run commands),
`LOCAL-MSE-SURVEY.md` (the local rig's real state), `TIMELINE-SCHEMA.md` (the bridge contract). After
editing any `PROJECT.md`, refresh the central index per `VIZ-PROJECTS/CLAUDE.md`.
