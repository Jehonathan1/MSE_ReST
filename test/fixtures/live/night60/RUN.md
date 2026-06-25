# night-60 — engine-console cleanup, confirmed LIVE at home

Self-driven proof that the night-59 engine-console CLEANUP detector works end to end
against a **real local Viz Engine** (no other app, no operator button). Run it yourself:

```
node scripts/night60-pipeline.js          # recorder + driver + asserts  -> recorder.jsonl (13/13 PASS)
node scripts/night60-mirror-capture.js     # viz-to-gsap live-server mirror over the JSONL (4/4 PASS)
```

Engine: **Viz Engine 3.14.5.102205** on `127.0.0.1:6100` (GH live, real i24news scene DB).

## What is REAL vs SEEDED (honest)

| Leg | Status | Note |
|---|---|---|
| Engine-console **cleanup DETECTION** | **REAL, live** | real engine, real `CONSOLE REDIRECT` + file tail, real `EngineConsoleAdapter` classifying real console lines from a real cleanup the driver fired, real off-air fan-out. **This is the night-59 deferred leg — now proven.** |
| The MSE **take** | **SEEDED** | a live MSE take + Pilot content are work-only on the bare rig (`LOCAL-MSE-SURVEY.md`); the actor/STOMP legs are stubbed and the on-air element is injected via the recorder's own `_onTakeSignal` (stubbed Pilot content), exactly as the offline tests seed a take. |
| The cleanup **trigger** | **REAL engine / replicated MSE shape** | the driver fires the on-site-faithful command sequence over TCP 6100 (engine-direct). The production path is the MSE profile cleanup (`POST /profiles/<p>/cleanup`); engine-direct produces the same engine-side console signature. |

**Still on-site only:** an MSE-driven take + an MSE-driven (`rel="cleanup"`) profile cleanup
against a populated profile. Engine-console DETECTION is no longer deferred.

## Rig setup (local dev engine only)

The on-site broadcast engine runs with command-echo on and in on-air control mode, which
is why its console shows the cleanup command lines. A bare dev engine has both off, so the
driver sets them first (Viz External Commands Manual): `MAIN SHOW_COMMANDS ON`,
`MAIN SWITCH_EXTERNAL ON`. The pipeline restores both to OFF at the end. The recorder never
sends these — the **driver** (a separate client) does. The recorder stays read-only.

## Live console format finding

The live Viz 3.14.5 engine echoes received commands **wrapped**:
`127.0.0.1:6100 (TCP): receive <0 SCENE CLEANUP>` — NOT the bare `SCENE CLEANUP` of the
on-site fixture. The night-59 classifier still latches **exactly one clear** through the
wrapper because the `CLEANUP` verb is a substring match. (The bare-only all-layer-unload
heuristic isn't needed — every real profile cleanup carries the CACHE CLEANUP block.)
Locked in by `test/engine-trigger.test.js` + `test/fixtures/engine-cleanup.wrapped.console.txt`.

## Evidence files (this folder)

- `recorder.jsonl` — the recorder's real output: take 20001 → **engine** off-air (cleanup) → per-element director off-airs. 3 instances, clean session bracket.
- `engine-console.excerpt.txt` — the real captured engine console: the load (`=== Loading SCENE BUG_TOP_LEFT ===`, textures *defined*) and the cleanup (`SCENE CLEANUP` → `TM: Texture …removed` + the full CLEANUP block).
- `driver.load.json` / `driver.cleanup.json` / `driver.takeout.json` — exact commands the driver sent + the engine's responses.
- `pipeline-checks.json` — the 13 recorder-side assertions (all PASS).
- `mirror-state.json` — the live-server mirror: `hold` snapshot while on air → `clear` snapshot after the cleanup; streamed `reveal→takeout` per instance.
- `mirror.hold.jsonl` / `mirror.clear.jsonl` — the recorder JSONL truncated at the take vs at the engine off-air (the two mirror snapshots).

## Asserted (all PASS)

- baseline idle = no false signals
- **load → NO false clear** (stripe stays on air; the load classifies as a load)
- **cleanup → exactly one clear**, engine-sourced, off-airs the on-air stripe, empties the map
- **single-layer take-out → NO over-fire** (the still-on-air element stays)
- per-element take-out still clears (the existing director off-air path, unchanged)
- **mirror op=hold → op=clear** via the real viz-to-gsap live-server (JSONL-decoupled)
