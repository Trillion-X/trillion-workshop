# virtual-list

Shared windowed-list primitive: renders only the visible slice of arbitrarily large item arrays so no consuming surface can freeze the app by materializing thousands of DOM rows.

## Files

| File | Purpose |
|------|---------|
| `VirtualList.tsx` | The `VirtualList` component — threshold-gated windowing over `@tanstack/react-virtual` |
| `test/timed-text-readers-browser.test.mjs` | Actual React/browser checks for bounded rows, measured passages, seeks, manual follow pause, stable focus and paused phone/desktop reflow using the real share stylesheet |
| `index.ts` | Barrel export of `VirtualList` + `VirtualListProps` |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `VirtualList<T>` | `(props: VirtualListProps<T>) => JSX` | Windowed list; below `threshold` renders plain keyed fragments, above it renders a spacer (`data-virtual-list-spacer`, height = total virtual size) with absolutely positioned `translateY` rows (`data-index`, `measureElement`) |
| `VirtualListProps<T>` | `{ items: readonly T[]; itemKey(item, index): string; renderItem(item, index): ReactNode; estimateSize(item, index): number; threshold?: number; scrollParent?: 'self' \| 'nearest'; maxHeight?: number; rowGap?: number; overscan?: number }` | Configuration; `scrollParent: 'self'` wraps rows in its own `overflow-y: auto` viewport (`data-virtual-list-viewport`) capped at `maxHeight`; `'nearest'` walks ancestors for the first `overflow-y: auto\|scroll` element |

## Dependencies

**Depends on:** MIT `@tanstack/react-virtual` (`useVirtualizer`), the shared UI `Container`.
**Depended on by:** `visual-database` (`VisualDatabaseSurface` ListView), `tasks` (`TaskList`, `KanbanBoard` columns), and any future surface rendering unbounded record arrays.

## Why This Design?

Freezing at N items is a category, not an instance (L063): any surface that maps a full record array into DOM rows is O(N) nodes. This primitive makes the category structurally impossible for consumers — they pass the full array and the DOM stays O(visible). The `threshold` keeps small lists as plain DOM (zero behavioral change, simpler a11y), and `data-virtual-list-viewport` / `data-virtual-list-spacer` / `data-index` markers are the browser-verifiable proof surface.

## Following and reflow

`followIndex`, `followKey` and `followTarget` keep a selected item or its active word visible. Width and height changes invalidate cached wrapping measurements and recenter that same target even when playback is paused and the caller's props have not changed. Geometry changes, including late measurements that move the followed row after a preceding row resizes, use immediate positioning rather than animating stale offsets. `followPausedRef` preserves the person's manual scroll/focus choice; `measurementKey` also invalidates heights after caller-controlled typography changes. Focused and followed rows are bounded additions to the visible slice.
