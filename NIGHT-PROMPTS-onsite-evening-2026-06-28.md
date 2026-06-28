# Laptop night prompts — land the on-site-evening fixes + close the two new defects

Source: `ONSITE-FINDINGS-2026-06-28-evening.md` (in the brought-home `Desktop\mse-viewer`/`Desktop\viz-to-gsap`).
Cowork could not hand-copy: every working-tree source file reachable through the Cowork mount is
**truncated** (both canonical and brought-home copies — e.g. `recorder.js` cut at line 444 `a.sourc`,
`live-mapper.js` at 361, `live-conductor.js` at 792). The committed **git HEAD blobs are intact**
(recorder 501 ln, live-mapper 431, live-conductor 929). So the fixes land via the laptop, reproduce-first
+ verify + merge, exactly like 61A/61B — the proven validated code is quoted inline below so Claude Code
re-applies it rather than re-deriving it.

## Map: his message → the work

| His words | What it is | Status | Prompt |
|---|---|---|---|
| "snap is gone (1↔2 hot-swaps animate)" | Defect 2 — production-hardened (real MSE delivers the pair split, home same-ts fixtures hid it) | ✅ validated on camera; not yet in canonical | **A** (viz-to-gsap) |
| "1-line/2-line text now animates, not snaps" | the variant-flip Line_1 string was popping on frame 0 | ✅ validated on camera; not yet in canonical | **A** (viz-to-gsap) |
| "right headline after cleanup" (Defect 1) | post-cleanup attribution | ✅ already in canonical (61B `0b1503e`) | — none — |
| (his evening report, not in his message) Defect 3 — re-take of an edited stripe reverted to the discarded edit | "Fix C" | ✅ offline 71/71, live partial; not yet in canonical | **B** (mse-viewer) |
| "take OUT leaves the mirror stuck until another take/cleanup" | Defect 5 — bare take-OUT emits no off-air | ❌ NEW, open | **C** (mse-viewer) |
| "change line2 shows old data before the update" | Defect 4 — stale working-copy read mis-attributed on a switch | ❌ NEW, open | **D** (mse-viewer) |

**Run order:** A and B are independent (land the validated fixes first). **D depends on B** (it extends the
same `_fetchMseElementData` Fix C rewrites). C is independent. Recommended: A → B → C → D.

**Preflight (every prompt):** local Viz Engine + app server running · `/model` Opus · `/clear` · Windows
sleep disabled · open Claude Code at the repo root in **auto-accept-edits** mode (Shift+Tab — plan/read-only
mode is what burned the 61A nights). **First, sanity-check the repo:** `node --version`, `git status`.
If viz-to-gsap errors `fatal: unknown index entry format` → rebuild the index: `rm -f .git/index && git reset`
(working tree preserved). If any target file fails `node --check`, restore it from HEAD before editing:
`git checkout -- <path>`.

---

## PROMPT A — viz-to-gsap: land the on-site snap-robustness refinements (issue 59 hardening)

> Read CLAUDE.md first. Create branch `night-62-snap-robustness` from main (`c896a97`).
> **Goal:** land the two on-site-validated refinements to the issue-59 hot-swap fix, which were proven on
> camera against the real MSE on 2026-06-28 but are not yet in canonical. Both fix the same observed defect:
> a 1↔2-line hot-swap that snapped (hard cut) instead of animating with the band held up.
>
> **Fix 1 — `convergence/live-mapper.js`, in `_onTake`.** The `lateSwap` detector currently matches the
> delayed takeout/take pair by EXACT ts equality. The real MSE delivers the off-air and the take ~1ms apart
> (home same-ts fixtures masked this), and the take's Pilot-content fetch can delay its write past `FLUSH_MS`,
> splitting the pair — so exact-ts misses it and the mirror plays a full Out-then-In (the snap). Widen it to
> the SAME `SWAP_WINDOW_MS` tolerance the coalesce path already uses (a genuine air-off has gaps ≥4s, far
> outside the window, so it is never mistaken for a swap). Replace:
> ```js
>     const lateSwap = !coalesce && isStripe && !!lastTakeout && lastTakeout.at === e.ts;
> ```
> with:
> ```js
>     const lateSwap = !coalesce && isStripe && !!lastTakeout
>       && Math.abs(Date.parse(e.ts) - Date.parse(lastTakeout.at)) <= SWAP_WINDOW_MS;
> ```
> (`SWAP_WINDOW_MS` is already defined at the top of the file. Update the adjacent comment to say the match is
> the SWAP_WINDOW_MS tolerance, not exact ts.)
>
> **Fix 2 — `convergence/player/live-conductor.js`, in `change()`, the VARIANT-FLIP branch
> (`if (d.variant !== prevVariant)`).** The Line_1 STRING change currently pops via a bare `relayoutText` on
> frame 0 while the line is fully visible (the "text snaps mid-flip" defect). Route it through the SAME masked
> change-wipe the same-variant path uses, so the string swaps off-screen at the trough. The wipe drives the
> nested child holder, so it composes with the outer line2change arrange without the two-writers hazard.
> Replace:
> ```js
>       relayoutText(L1node, newL1);
> ```
> (the one inside the variant-flip branch, immediately after `cur.variant = d.variant;`) with:
> ```js
>       wipeLine(changeTl1, L1node, prevL1, newL1, trough1, entry1);
> ```
> Leave the Line_2 handling in that branch unchanged (forward flip fades Line_2 IN as the arrange; reverse
> flip slides the OLD Line_2 OUT). `wipeLine`, `changeTl1`, `trough1`, `entry1` are all already in scope (used
> by the same-variant branch right below).
>
> **Reproduce-first:** add/extend a test that drives a variant-flipping hot-swap where the takeout and take
> arrive split by ~1ms (NOT same-ts) — assert the mapper emits a `change` (hot-swap), not a fresh
> reveal/Out-then-In; and a conductor test that on a variant flip the Line_1 string is driven by `changeTl1`
> (masked wipe), not set instantly at progress 0. Both FAIL on HEAD, PASS after.
> **Out of scope:** the per-frame render-probe harness, recorder, mse-viewer, any other conductor path.
> **Done when:** `node --test` green; `verify-generic.js` reports NO REAL FINDINGS (the snap/variant beats
> still pixel-match the engine oracle); live smoke 0 JS errors; merged to main; PROJECT.md issue 59 updated
> ("on-site hardening: SWAP_WINDOW_MS lateSwap + masked Line_1 wipe on variant flip") + Lessons; KB note that
> the real MSE splits the hot-swap pair (home same-ts fixtures hid it).
> If 3 research-backed hypotheses fail on the same mismatch, stop and write the stuck-report per CLAUDE.md.

---

## PROMPT B — mse-viewer: land Fix C (Defect 3 — re-take stale revert)

> Read CLAUDE.md first. Create branch `night-62b-fixc-retake-stale` from main (`0b1503e`).
> **Goal:** land "Fix C" from the 2026-06-28 evening on-site session (offline-verified 71/71 there, but
> uncommitted and only on the work copy). Symptom: a stripe is taken → on-air-edited → taken off → **re-taken**;
> the re-take reloads the original Pilot content, but the mirror momentarily flashed the **discarded edit**.
> Root cause: the take-time reconcile read the live working copy via the Director adapter's CACHED
> `lastTakenPath`, which FREEZES on off-air (night-61b), so on a fresh re-take it still pointed at the prior
> edited VCP working instance — surfacing the discarded edit as a spurious `change`.
>
> Apply to `src/recorder/recorder.js`:
> 1. Add `parseLastTakenElement` to the existing destructured import from `./parsers` (it is already exported
>    there).
> 2. Add this helper near the top (after the imports):
> ```js
> // MSE-path content signature. The live on-air working copy (a VCP last_open_template node) and the saved
> // Pilot element name their fields differently (MSE "0"/"1" vs Pilot "01"/"02"), so a field-keyed signature
> // can't be compared across the two. The ORDERED texts[] array is identical across both parsers, so the MSE
> // change detector keys on texts — letting the baseline be seeded from the Pilot-sourced take content and
> // then compared against later MSE-sourced reads.
> function mseTextsSig(content) {
>   return JSON.stringify((content && content.texts) || []);
> }
> ```
> 3. At take time, right after the take content is resolved (where `entry` is built), seed the MSE baseline
>    from the take's ordered texts so the FIRST on-air edit is not swallowed:
> ```js
>     // Seed the MSE-data baseline from the take content's ORDERED texts now, so the FIRST on-air edit
>     // registers as a change. Without this seed the baseline would be established by the first VCP
>     // working-copy read — which only exists AFTER an edit — silently swallowing that first edit.
>     entry.mseSig = mseTextsSig(resolved.content);
> ```
> 4. Replace the two later `contentSignature(...)` calls used for the MSE-change baseline/compare with
>    `mseTextsSig(...)` — i.e. `entry.mseSig = contentSignature(live)` → `mseTextsSig(live)`, and the
>    `const sig = contentSignature(resolved.content)` in the MSE-data poll → `mseTextsSig(resolved.content)`.
>    (Leave any Pilot/Director-path `contentSignature` uses alone — only the MSE-data path changes.)
> 5. Rewrite `_fetchMseElementData(elementId)` to resolve `last_taken` FRESHLY and read ONLY a VCP working
>    instance:
> ```js
>   async _fetchMseElementData(elementId) {
>     const director = this.adapters.find(
>       (a) => a.source === 'director' && typeof a.getNode === 'function');
>     if (!director) return { content: null };
>     let ref = null;
>     try {
>       const ltx = await director.getNode('/state/last_taken_element');
>       ref = parseLastTakenElement(ltx);
>     } catch (e) { ref = null; }
>     // Only the VCP working instance carries on-air edits. Anything else (a pilotdb saved element, or no
>     // resolvable path) → no working copy to read this tick.
>     if (!ref || !ref.isTemplate || !ref.path) return { content: null };
>     let xml = null;
>     try { xml = await director.getNode(ref.path); } catch (e) { xml = null; }
>     if (!xml) return { content: null };
>     return { content: parseMseElementData(xml, elementId) };
>   }
> ```
>
> **Reproduce-first:** the two "Fix C" tests from the evening session — (a) a discarded-edit re-take emits NO
> stale change and never reads the stale VCP node; (b) a *genuine* surviving VCP edit IS still surfaced. Both
> FAIL on `0b1503e`, PASS after. Keep the full suite green (was 71/71 on the work copy).
> **Out of scope:** Defects 4 and 5 (separate prompts), the live-server/conductor, viz-to-gsap.
> **Done when:** `node --test` all green; reproduce-first tests confirmed FAIL→PASS; merged to main;
> PROJECT.md issue (Defect 3 / "Fix C") + Lessons recorded. Note in the report that the live re-confirm of the
> re-take path is still pending (it was not independently re-exercised on-site).
> If 3 research-backed hypotheses fail on the same mismatch, stop and write the stuck-report.

---

## PROMPT C — mse-viewer: Defect 5 — a bare take-OUT does not clear the mirror (NEW)

> Read CLAUDE.md first. Create branch `night-63-bare-takeout-offair` from main (after Prompt B merges).
> **Goal:** a stripe taken **OUT** with nothing replacing it stays **stuck** on the mirror; it only clears when
> the operator takes a DIFFERENT stripe or fires a cleanup. Evidence: in
> `recordings/2026-06-28T16-26-42.128Z.jsonl` every `off-air` is immediately followed by a different take at
> the same ts (the single-occupancy *synthesized* off-air) or is an engine cleanup — **no standalone take-OUT
> off-air was ever recorded**. So a bare OUT produces no off-air signal and the mirror never goes to takeout.
> (The fixture is banked at `recordings/2026-06-28T16-26-42.128Z.jsonl`.)
>
> **Suspected root cause (from the on-site report):** takes/offs flow via the STOMP channel-state feed
> (actor `subscribe` is `not_implemented`), and `directorAdapter` FREEZES `lastTakenPath` on off-air
> (night-61b). A replacement take synthesizes the outgoing element's off-air (single-occupancy); a cleanup
> off-airs everything. But a bare OUT — the channel going empty with no replacement — is evidently not
> surfaced as an off-air at all.
>
> **Step 0 — find the signal (read-only investigation).** Locate where a bare OUT appears in the channel-state
> / playout feed the directorAdapter already subscribes to (the channel's on-air element list going empty, or
> the relevant `/state` node clearing). Confirm against the raw director capture if one exists
> (`recordings/director/`); otherwise characterize from the channel-state message shapes the adapter handles.
> **The fix:** emit an `off-air` for the element that left the channel when the channel empties with no
> replacement — WITHOUT reintroducing the night-61b phantom-take regression the `lastTakenPath` freeze was
> protecting against (do not un-freeze the cache; derive the bare-OUT off-air from the channel-state going
> empty, not from `last_taken`).
>
> **Reproduce-first:** a directorAdapter unit test that feeds a channel-state sequence ending in a bare OUT
> (channel empties, no new take) and asserts exactly one `off-air` is emitted for the outgoing element — and a
> guard test that a normal take-out-then-take (replacement) still emits exactly one off-air (no double-fire)
> and a cleanup still fans all. FAIL on HEAD, PASS after.
> **Out of scope:** Defect 4, Fix C internals, viz-to-gsap.
> **Done when:** `node --test` green incl. the new fail-first tests; no regression to the night-61b
> phantom-take guard or the cleanup fan-out; merged; PROJECT.md (Defect 5) + Lessons recorded. If the bare-OUT
> signal cannot be confirmed offline from the captured feed, STOP and write a short report naming exactly which
> channel-state field you'd need to watch live — this becomes a read-only check for the next on-site trip,
> not a guessed fix.
> If 3 research-backed hypotheses fail on the same mismatch, stop and write the stuck-report.

---

## PROMPT D — mse-viewer: Defect 4 — stale/wrong text on a stripe switch (NEW; depends on B)

> Read CLAUDE.md first. Create branch `night-64-switch-cross-attribution` from main (AFTER Prompt B merged —
> this extends the `_fetchMseElementData` Fix C rewrites).
> **Goal:** on switching to a different stripe (and on a Line_2 change of a freshly-switched stripe), the
> mirror shows **wrong/old text, then corrects** — a stale-content flicker. Evidence in
> `recordings/2026-06-28T16-26-42.128Z.jsonl`:
> ```
> seq 15 | take   | director | 2384231 | ONE_LINE | ["מפקד סנטקום יגיע לישראל"]            (correct fresh take)
> seq 16 | change | mse      | 2384231 | TWO_LINE | ["…לבנון השלישית","…בריכה"]            (WRONG — 2385709's edited text, mislabeled onto 2384231)
> ```
> Seq 16 carries the PREVIOUS element 2385709's on-air-edited two-line content but is attributed to the
> just-taken 2384231 (even flipping its variant to TWO_LINE).
>
> **Root cause:** Fix C made `_fetchMseElementData` resolve `last_taken` freshly and read the VCP working
> instance, but it then attributes that content to the passed-in `elementId` under the single-occupancy
> assumption — it does NOT verify the VCP working instance actually BELONGS to `elementId`. On a stripe→stripe
> switch, `last_taken` / `last_open_template` LAGS and still names the OUTGOING element's working copy, so the
> poll reads 2385709's edit and mislabels it as 2384231.
>
> **Candidate fix (from the on-site report):** in `_fetchMseElementData`, only trust a VCP working-instance
> read when it can be tied to `elementId` — derive the element id / `based_on` from the VCP node (or from the
> freshly-resolved `last_taken` ref) and require it to equal `elementId`; otherwise return `{ content: null }`
> and let the settled poll seed from a matching read. Verify whatever identity the VCP node actually exposes
> before relying on it (read a real node first; do not assume a field name).
>
> **Reproduce-first:** a recorder/`_fetchMseElementData` unit test mirroring seq 15→16 — `last_taken` resolves
> to the OUTGOING element's VCP working copy while the on-air element is the newly-taken one — assert the read
> is rejected (`{content:null}`), so no stale `change` is emitted against the new element; plus a positive test
> that a genuine edit on the CURRENT element IS still surfaced. FAIL on HEAD, PASS after.
> **Out of scope:** Defect 5, viz-to-gsap, the cleanup path.
> **Done when:** `node --test` green incl. fail-first tests; Fix C's own tests still pass (no regression to the
> re-take path); merged; PROJECT.md (Defect 4) + Lessons recorded. Note whether the Line_2-change-shows-stale
> variant he reported is fully covered by the same guard or needs its own case.
> If 3 research-backed hypotheses fail on the same mismatch, stop and write the stuck-report.

---

## After all four merge
The mirror is then clean on every transition AND the full lifecycle (take / change / hot-swap / variant flip /
bare OUT / cleanup). That is the camera-clean bar for the polished re-film → case study (step 9) → Vizrt
(step 10). Manual, still yours: push origin (canonical mse-viewer + viz-to-gsap are ahead, unpushed);
restore the night-58 redline `stash@{0}`.
