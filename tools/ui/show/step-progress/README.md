# ui/show/step-progress — walkthrough progress projection (M6)

The universal progress facts of a walkthrough (current/total/ratio/first/last) + a blind style registry so the *visual* (counter/dots/bar/segmented/…) is DATA, not a code branch.

## Files

| File | Purpose |
|------|---------|
| `step-progress.ts` | Pure `progressState(cursor, total)` + `segmentFills(state)` + `createStepProgressRegistry(fallback)` (blind style dispatch via `blind-registry`). |
| `StepProgress.tsx` | React seam — resolves the visual for `style` and mounts it with the state; never branches on style. |
| `index.ts` | Barrel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `ProgressState` | `{ index, current, total, ratio, isFirst, isLast }` | Universal facts every visual reads — counter/dots/bar all agree because they share it. |
| `progressState(cursorIndex, total)` | `→ ProgressState` | Pure; clamps cursor, no divide-by-zero at total 0. |
| `segmentFills(state)` | `→ boolean[]` | Per-step fill (≤ cursor) for dots/segments. |
| `createStepProgressRegistry<R>(fallback)` | `→ BlindRegistry<R>` | `progress_style.style` (open string) → visual; delegates to `blind-registry`. |
| `StepProgress({registry, style, state})` | React component | Mounts the resolved visual; no `switch(style)`. |

## Why This Design

The progress *facts* are Physics (one projection); the progress *visual* is Society (`style` DATA). A new visual = `register(style, renderer)` + zero change. Reuses `ui/show/blind-registry` for the dispatch (its 3rd consumer), so the anti-enum guarantee lives in one place.

## Dependencies

**Depends on:** `ui/show/blind-registry`, `react` (seam only).
**Depended on by (planned):** the `guided-overlay` engine (M6) and its consumers' default visual set (counter/dots/bar/segmented reusing `progress-bar`/`completion-ring`).
