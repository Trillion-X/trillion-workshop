# step-pill

A small pill of named stages in order, each drawn with the shared step mark: empty ring (waiting), breathing ring (worked on now), round tick (done).

## Files

| File | Purpose |
|---|---|
| `StepPill.tsx` | `StepPill({ stages, label })`; each stage is `{ id, label, state: StepMarkState, said? }`. |
| `index.ts` | The public entry (declared in `ui/part.json`). |

## Dependencies

**Depends on:** `container`, `text`, `step-mark`.

**Depended on by:** `parts/record-audio/show/ProcessingStepsPill.tsx` (a recording's Upload, Transcript, Summary).

## Invariants

1. Presentational; every word is the caller's. 2. Draws nothing without stages. 3. Marks only from `step-mark`.
