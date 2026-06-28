# NIGHT 61B — post-cleanup take attribution (Defect 1) + the variant mirror, mse-viewer ONLY (single repo)

Split of the cross-repo prompt — runs ENTIRELY inside `mse-viewer`. Re-applies the on-site fix BY EDIT
(no cross-repo git fetch / cherry-pick — those aren't allowlisted and the work copy is outside this root),
reproduces it offline, verifies, merges. The work-machine reference commit is `4cd168d` ("Fix post-cleanup
take attribution and stripe variant derivation"); the exact changes are embedded below so you don't need
to reach the work copy.

## Run it here
Open Claude Code in **`C:\Users\i24news\Desktop\VIZ-PROJECTS\mse-viewer`** (CANONICAL — its
`.claude/settings.local.json` grants Edit/Write/git-commit in dontAsk). Canonical HEAD is `57a4f45`.
Commit on E, ff-promote to C, never push origin.

## Preflight
`/model` Opus, `/clear`, sleep disabled. Local engine NOT required (offline test only).

---

## PASTE THIS INTO CLAUDE CODE (inside mse-viewer)

```
Read CLAUDE.md first. Create branch night-61b-cleanup-attribution from main (57a4f45). Single repo; STRICT
read-only toward live infra (the recorder gains NO write/POST path). Re-apply the on-site fix BY EDITING
the files (do not fetch/cherry-pick across repos), then reproduce-first, verify, merge.

Context (full report lives in ../viz-to-gsap/convergence/ONSITE-FINDINGS-2026-06-28.md; if unreachable,
everything you need is here): after a profile/engine cleanup, taking an element DIRECTLY (no playlist
initialize) mirrored the PREVIOUS headline then snapped. Cause: the actor's last_taken_element is a take
cursor, NOT an on-air flag; a cleanup does NOT reset it, so the next id-less line take was attributed to
the now-off-air element. (KB: cleanup never clears last_taken — this confirms it.) A reverted misstep:
folding the live working copy at take-time is WRONG — it lags ~1.4s after a cleanup→take and serves stale
content; read it only at settled time, never to attribute the take.

EDIT 1 — src/recorder/recorder.js, in _onClearSignal(), AFTER the loop that off-airs every on-air id, add:
    this._lastTakenStripeId = null;
    for (const a of this.adapters) { if (typeof a.handleClear === 'function') a.handleClear(); }
(comment: a cleanup doesn't reset last_taken; drop stale cursor/bookkeeping so the next post-cleanup take
resolves from the authoritative last_taken read.)

EDIT 2 — src/recorder/adapters/directorAdapter.js:
  (a) change getNode(path) to getNode(path, timeoutMs); inside, change
      `const timeout = (this.cfg && this.cfg.pilotTimeoutMs) || 5000;`
      to `const timeout = timeoutMs || (this.cfg && this.cfg.pilotTimeoutMs) || 5000;`
  (b) add a method (before stop()):
      handleClear() {
        this.currentActiveElementId = null;
        this.lineToElement.clear();
      }
  (comment: a cleanup leaves the attribution maps pointing at a now-off-air element; clear them so the next
  take re-resolves. Leave lastTakenPath frozen on purpose — nulling it would re-emit the off-air element as
  a phantom take.)

EDIT 3 — src/recorder/parsers.js deriveVariant(content, line2Field='1') — make it derive from texts[]
(verbatim mirror of viz-to-gsap live-mapper, fixes the all-TWO_LINE mislabel from the 0-based/1-based
field-index bug):
    if (!content) return null;
    if (Array.isArray(content.texts)) {
      const l2 = content.texts.length >= 2 ? content.texts[1] : '';
      return l2 && String(l2).trim() ? 'TWO_LINE' : 'ONE_LINE';
    }
    if (!content.fields) return null;
    // ...existing getField fallback unchanged...

STEP 4 — REPRODUCE-FIRST tests (gate FAIL-on-HEAD → PASS):
  (a) Defect 1: a cleanup signal then an id-less DIRECT take (no initialize) must attribute to the element
      ACTUALLY taken (resolved from the authoritative last_taken), NOT the frozen pre-cleanup cursor.
      Assert it FAILS on 57a4f45 and PASSES after EDIT 1+2. Add a fixture for the cleanup→direct-take path
      if none exists (fixture-per-signal). Also add a guard test that the lagging working copy is NOT folded
      at take-time.
  (b) Defect 2 mirror: deriveVariant on 1-based Pilot content ("01" non-empty, "02":"") returns ONE_LINE
      (was TWO_LINE on HEAD); on texts of length 1 → ONE_LINE; length 2 non-empty → TWO_LINE.

STEP 5 — node --test green (target 65/65+). Add a PROJECT.md Lessons entry: last_taken is a take cursor not
an on-air flag; cleanup doesn't reset it; do NOT fold the ~1.4s-lagging working copy at take-time; variant
must derive from normalized texts[] not the padded field key.

Out of scope: NO recorder write/POST path; NO ../viz-to-gsap changes (that's 61A); NO engine/MSE writes.

Done when: both reproduce tests FAIL on 57a4f45 → PASS after the edits; node --test green; PROJECT.md
issue (mse-viewer) + Lessons updated; merged E→ff→C (NO origin push). If 3 research-backed hypotheses fail
on the same mismatch, stop and write the stuck-report per CLAUDE.md.
```

---
Order: run **61A (viz-to-gsap)** and **61B (mse-viewer)** independently, in their own canonical repos —
no dependency between them. After both: mirror is camera-clean → re-film → case study → Vizrt.
