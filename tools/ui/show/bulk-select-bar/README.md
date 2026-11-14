# bulk-select-bar/

A pure selection-actions bar that appears when a caller's selection count > 0, showing "N selected · Clear" plus caller-supplied batch-action buttons that fold into a "More" overflow menu when they don't fit.

## Files

| File | Purpose |
|------|---------|
| `BulkSelectBar.tsx` | The bar component + its internal `OverflowMenu` (priority overflow, responsive collapse-to-fit, viewport-aware menu). |
| `BulkSelectBar.test.tsx` | Vitest coverage: empty render, action firing, disabled actions, overflow fold/menu, placement-aware cap. |
| `index.ts` | Barrel re-export of `BulkSelectBar` + its public types. |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `BulkSelectBar` | `(props: BulkSelectBarProps) => JSX \| null` | The bar. Renders `null` when `selectedCount === 0`. |
| `BulkSelectBarProps` | `{ selectedCount: number; onClearAll: () => void; actions: readonly BulkSelectBarAction[]; words?: { selected(count), clear, more, actions }; maxInline?: number; children?: ReactNode; placement?: 'top' \| 'floating'; anchor?: 'viewport' \| 'container'; className?: string }` | Caller owns selection state + every action handler; the bar never knows what is selected. Optional `words` supplies caller-owned selected-count, clear, overflow and toolbar labels; English defaults preserve existing callers. |
| `anchor` (floating only) | `'viewport'` (default) = `position: fixed`, pinned to the screen · `'container'` = `position: absolute`, pinned to the caller's nearest `position: relative` ancestor | Use `'container'` when a `fixed` pill would be captured by an ancestor's backdrop-filter/transform containing block. Closed CSS pair, not an extensible set. |
| `BulkSelectBarAction` | `{ label: string; onClick: () => void; variant?: 'default' \| 'danger'; disabled?: boolean }` | One batch action. Passed in priority order — the first that fit render inline, the rest fold into "More". `label` must be unique within the array (used as the React key). |

### Behavior

- **Priority overflow** (Mobbin canon — Dovetail/Linear/Drive): inline actions render first; the remainder fold into a trailing `⋯ More` popover. Purely positional — the bar never branches on what an action means.
- **Responsive collapse-to-fit**: the bar is bounded to its containing block (`max-w`); the inline count collapses by real browser measurement (`scrollWidth` vs `clientWidth`) until it fits, and grows back via `ResizeObserver` when the pane widens. No hand-tuned pixel constants. Falls back to a placement-aware cap (`top: 8`, `floating: 5`) where layout isn't measurable (e.g. jsdom).
- **Viewport-aware menu**: height-capped + scrollable (`max-h-[60vh]`), opens toward whichever side has more room, so it never runs off the top or bottom.

## Dependencies

**Depends on:** `@/packages/ui/show/button` (Button), `@/packages/ui/show/icon` (Icon), `@/packages/ui/show/text` (Text), `@/packages/ui/show/cn` (cn), `lucide-react` (MoreHorizontal), `react`.

**Depended on by:** `@/packages/group` (GroupBoardPanel — floating board batch bar), `@/packages/visual-database` (VisualDatabaseSurface), `@/packages/agents-hub` (AgentsHubSurface). Re-exported through the `@/packages/ui` barrel (`packages/ui/index.ts`).
