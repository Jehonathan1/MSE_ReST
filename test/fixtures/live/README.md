# Live Stage-2d captures (committed mirrors)

These are **byte-for-byte mirrors** of the real read-only captures taken against
the i24 production MSE on 2026-06-17. The working copies live in the gitignored
`recordings/` tree ("office captures live outside git"); they are mirrored here so
the Stage-3 timeline/sufficiency tests are reproducible on a fresh clone.

| File | Capture | Reconstructs to |
|---|---|---|
| `2026-06-17T09-15-40.203Z.jsonl` | 16-event end-to-end (`--source auto`) | 5 TWO_LINE Stripes + 1 exclusive-gate window + clean close |
| `2026-06-17T09-04-40.330Z.jsonl` | 13-event Director (`--source auto`) | 4 TWO_LINE Stripes + 1 gate window + clean close |
| `2026-06-17T09-27-53.322Z.jsonl` | 4-event Trio-only (`--source trio`) | 0 instances + clean close (a PASS, not a failure) |
| `2026-06-17T09-15-40.203Z.timeline.json` | emitted contract for the 16-event capture | the committed Stage-4 bridge artifact (`timeline.js --emit`) |

Regenerate the committed artifact:

```bash
node timeline.js test/fixtures/live/2026-06-17T09-15-40.203Z.jsonl \
  --emit --out test/fixtures/live/2026-06-17T09-15-40.203Z.timeline.json
```

The `the committed 16-event timeline.json equals a fresh re-emit` test guards it
against drift. See `../../../TIMELINE-SCHEMA.md` for the contract.
