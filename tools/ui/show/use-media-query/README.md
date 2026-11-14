# use-media-query

One live React answer to "does this media query match right now?", shared by every screen question the browser already answers.

## Files

| File | Purpose |
|---|---|
| `use-media-query.ts` | `useMediaQuery(query)` over `matchMedia` + `useSyncExternalStore`, and `usePrefersReducedMotion()` for `(prefers-reduced-motion: reduce)`. |

## Key Types / Functions

| Name | Signature | Role |
|---|---|---|
| `useMediaQuery` | `(query: string) => boolean` | Current match, re-rendering on change; `false` without `matchMedia`. |
| `REDUCED_MOTION_QUERY` | `'(prefers-reduced-motion: reduce)'` | The reduced-motion query. |
| `usePrefersReducedMotion` | `() => boolean` | True while the person asked for less motion. Read live, never cached at module load (framer-motion's `useReducedMotion` caches its first answer). |

## Dependencies

**Depends on:** `react`.
**Depended on by:** `ui/show/use-narrow-viewport/useNarrowViewport.ts`, `screen-arrangement/show/SplitTreeArranger.tsx`.
