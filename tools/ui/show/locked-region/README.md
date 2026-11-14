# ui/show/locked-region — the one answer to "is this place locked?"

A locked region is any element carrying `data-locked`. Inside it only the region's own controls act: every layer that works across the whole page asks `isLockedAt(node)` about the node its event is on and does nothing there. The arrangement lock (`screen-arrangement/show/arrangement-lock.tsx`) marks its frame, so Trillion's setup gate and every hold are locked for every layer, including layers added later.

## Files

| File | Purpose |
|------|---------|
| `locked-region.ts` | `LOCKED_ATTRIBUTE` and `isLockedAt(node)`: true when the node or an ancestor carries `data-locked`. |
| `index.ts` | Barrel. |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `LOCKED_ATTRIBUTE` | `'data-locked'` | The attribute a locker puts on its region. |
| `isLockedAt` | `(node: unknown) => boolean` | Asked by page-wide layers before acting on an event's node; text nodes judged by their parent; non-nodes are never locked. |

## Invariants

1. Blind: names no layer, screen or reason.
2. Nested regions resolve by `closest()`, no special case.
3. No state, no side effects.

## Who must ask it

Every listener that acts on the whole document or on an arrangement viewport: `ui/show/responses/SelectionResponses` (comments, reactions, highlights on selected words), `screen-arrangement/show/canvas-gestures` (zoom, pan, pinch), Trillion's pointing host (`src/workspace/point-at-anything.tsx`). `test/locked-region.test.mjs` fails when a file adds a page-wide `selectionchange` listener or binds arrangement canvas gestures without asking it (a screen's own editor is kept apart there with its reason).

## Dependencies

**Depends on:** the DOM only.
**Depended on by:** `screen-arrangement/show/arrangement-lock.tsx` (marks its frame), `ui/show/responses/SelectionResponses.tsx`, `screen-arrangement/show/canvas-gestures.ts`, `src/workspace/point-at-anything.tsx`.
