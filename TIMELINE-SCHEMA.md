# Reconstructed-Timeline Schema — the Stage-4 bridge contract

This is the normalized, documented artifact **Stage 4 (the viz-to-gsap bridge)
consumes**. Stage 3 proves the Stage-2d captures are *sufficient* — they contain
everything the bridge needs — and emits this contract with **no rendering**.

- **Emitter:** `timeline.js` (`buildTimeline(events)` / `node timeline.js <file> --emit`).
  Also reachable as `node replay.js <file> --emit`.
- **Sufficiency check:** `node timeline.js <file> --report` (or `replay.js … --report`).
- **Committed example:** `test/fixtures/live/2026-06-17T09-15-40.203Z.timeline.json`
  — the 16-event end-to-end capture, reconstructed. (The working captures live in
  the gitignored `recordings/`; byte-for-byte mirrors are committed under
  `test/fixtures/live/` so the artifact and its tests survive a fresh clone.)

It builds on `replay.js` `reconstruct()`, which already rebuilds
**take → content → variant → left** and **fails loud** on a truncated recording
(a half-written line, or a dangling on-air element with no clean `session stop`).

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "source": "2026-06-17T09-15-40.203Z.jsonl",   // capture filename (provenance)
  "capture": {
    "recordedAt": "2026-06-17T09:15:40.205Z",    // session-start ts
    "detectionSource": "auto",                    // recorder --source (auto|director|trio)
    "sessionStopped": true,                       // clean close? (false ⇒ reconstruct would have thrown)
    "eventCount": 15                              // from the session-stop line
  },
  "stripeTemplateId": "16097",                    // template that marks a Stripe
  "line2Field": "2",                              // field whose emptiness picks ONE_/TWO_LINE
  "exclusiveField": null,                         // badge field number — still unidentified (non-blocking)
  "stripeCount": 5,
  "stripes": [ /* Stripe instances — see below */ ],
  "gateWindows": [ /* provenance: the co-airing non-Stripe (16092) elements */ ]
}
```

## Per Stripe instance

```jsonc
{
  "elementId": "2369176",
  "templateId": "16097",
  "tookAt": "2026-06-17T09:16:50.657Z",
  "leftAt": "2026-06-17T09:17:48.883Z",   // null when still on air at clean stop
  "stillOnAir": false,                     // true ⇒ on air when recording stopped (leftAt null)
  "variant": "TWO_LINE",                   // variant at take-in
  "states": [                              // distinct content states over the instance life
    {
      "at": "2026-06-17T09:16:50.657Z",
      "variant": "TWO_LINE",               // "is Line_2 empty?" → ONE_LINE / TWO_LINE
      "texts": ["הפסקת אש? ירי בזמן ביקור רה\"מ", "נתניהו ביקר בבי\"ס בשלומי …"],
      "fields": { "01": "…", "02": "…" }   // numeric Pilot fields
    }
  ],
  "exclusiveGate": [                        // gate transitions during this instance (may be [])
    { "at": "2026-06-17T09:17:22.738Z", "on": true },
    { "at": "2026-06-17T09:17:37.314Z", "on": false }
  ]
}
```

- **`states`** is the take state followed by one entry per genuine content change
  (variant or text). A take is always the first state; an unchanged `change` does
  not add one.
- **`variant`** is derived exactly as the live `line2Change` script decides:
  `TWO_LINE` when the `line2Field` is non-empty, else `ONE_LINE`. (No live
  single-line Stripe was captured; the rule is derived + unit-proven, not faked.)

## The exclusive gate — derived from the co-airing element, not a field

The exclusive ("בלעדי") badge is a **separate Pilot element on template 16092**,
NOT a field on the Stripe template 16097 (Stage-2d finding; KB §4b). It
**co-exists** with the on-air Stripe rather than replacing it. So the gate is
derived from 16092's lifecycle:

- `take(16092)` while a Stripe is on air ⇒ **gate ON** on that Stripe;
- `off-air(16092)` ⇒ **gate OFF**.

The 16092 element is **kept OUT of the `stripes` list** (it is a separate
element) and its on/off is **folded into the concurrent Stripe's
`exclusiveGate`**. "Concurrent Stripe" = the most-recently-taken Stripe still on
air at the gate's take time (the visible one). The raw 16092 windows are also
surfaced under top-level `gateWindows` for provenance:

```jsonc
{ "elementId": "2378195", "templateId": "16092",
  "on": "2026-06-17T09:17:22.738Z", "off": "2026-06-17T09:17:37.314Z",
  "stillOnAir": false, "concurrentStripe": "2369176" }
```

## How Stage 4 maps the contract

| Contract | Stage-4 bridge action |
|---|---|
| `take` (instance start, `tookAt` + first `state`) | **In** |
| each subsequent `states[]` entry | **Change** (re-key Line_1/Line_2; variant may flip) |
| `leftAt` / off-air (`stillOnAir:false`) | **Out** |
| `exclusiveGate[] {on:true/false}` | **Gate** ON / OFF (exclusive badge) |
| `variant` (`ONE_LINE`/`TWO_LINE`) | which line layout to play — from "is Line_2 empty?" |

`stillOnAir:true` means the instance was live when the capture stopped (the demo
holds it on air); `leftAt` is its Out time otherwise.

## Sufficiency

`--report` asserts, for a capture, that the bridge has what it needs:

- session closed cleanly;
- every reconstructed state carries **real Pilot content** (no `contentPending`);
- every Stripe `variant` is derived;
- each exclusive gate **co-exists** (does not off-air its Stripe) and maps to an
  ON→OFF window;
- and it **prints any field the bridge would want but the capture lacks**.

A capture with **zero Stripe instances and a clean close** (e.g. a Trio-only run
at this site, where STOMP carries no `based_on`) is a **PASS**, not a failure.

### Known non-blocking gaps (declared, not papered over)

- **`exclusiveField` unidentified** — the exclusive badge's numeric Pilot field on
  16097 is unknown, so per-Stripe `exclusive` stays `null`. **Non-blocking:** the
  bridge derives Gate from the co-airing **16092** element instead.
- **No live ONE_LINE Stripe captured** — every captured Stripe was TWO_LINE.
  **Non-blocking:** variant is *derived* ("is Line_2 empty?") and unit-proven; the
  case is derived, not fabricated.
- **Template-only takes have `elementId:null`** — a take of an open template (no
  Pilot data element) cannot be content-resolved. **Non-blocking:** it is not a
  Stripe data element and none appear in these captures.
