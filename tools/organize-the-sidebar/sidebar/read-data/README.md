# sidebar/read-data

Pure readers of what the sidebar shows and offers, plus the sidebar's own DATA. Nothing here renders or writes.

## Files

| File | Purpose |
|---|---|
| `sidebar-settings.ts` | The sidebar's named on/off switches at every level (sidebar, list, row), and the width rows that set them for the window's current width. |
| `sidebar-settings-by-width.json` | DATA: which switches are on or off while the window is narrower than each row's width. On a phone: Show / Hide off, `stay_open` off; Position stays. Collapsed, the sidebar is its thin bar at every width, on an edge or a seam; only when even the bar would leave the work too narrow (`docked-list-fit.ts`) is it a handle. |
| `sidebar-badge-marks.json` | DATA: the mark a row's live badge gets, by the badge's kind (`count`, `notification`) and whether the row shows its name (`with_label`) or only its icon (`icon_only`): `number`, `dot` (small red dot) or `none`. Collapsed: a notification is a dot, a count nothing. |
| `sidebar-badge-marks.ts` | Reads that DATA (a missing kind or malformed row uses `fallback`, a mark the row cannot draw is ignored) and answers the mark for a badge. |
| `docked-list-fit.ts` | Whether a list docked beside the work leaves the work room to be used: the room along the docked axis minus the open list (or its collapsed rail) against the smallest usable pane (screen-arrangement's `minUsableContainerWidthPx()`). A measurement, never a device or a width. |
| `live-graph.ts` | A caller-projected list graph the caller may replace while the page is open (lists a rule fills: New, a tag's list); `useProjectedGraph(first)` follows the newest graph handed out for `first`, `replaceProjectedGraph(first, next)` hands one out (an equal graph wakes nobody). |
| `merge-surface-collections.ts` | Lays the person's saved copy of each app list over that list and appends their own lists; then shows each screen in one list only (`showEachSurfaceOnce`): the person's placement first, else the first list shown. A row a saved copy holds only because the app put it there (it lacks `placed_by_person`) follows the app when the app moves it to another of its lists. A list whose settings say `repeats_rows` (`repeatsRows`) keeps every row it holds and takes none from another list; its saved copy keeps a row its rule no longer picks only when the person put it there. |
| `bar-fit.ts` | How many icons the thin bar shows: every row, the bar scrolling along its length when they do not all fit (room never hides a row); the person's `fit.max` bounds it, the rest going behind More; the open screen's row always stays on the bar; empty space rows take no count and keep their places. `rowsShown`, `splitBarEntries`. |
| `sidebar-bar.json` | DATA: the thin bar's thickness, its padding, its button and icon sizes, and the room each icon, its grip and its More button take; `bar-fit.ts` reads it and `show/SidebarBar.tsx` sets the sizes on the bar. |
| `space-row.ts` | The empty space row (`sidebar.space`): a row that holds nothing. On the thin bar it pushes the icons apart, so where spaces stand decides where the icons sit, and spaces side by side add up; each one added is its own row (`spaceMemberId`). |
| `read-published-records.ts` | Reads the current published records the sidebar lists. |
| `read-sidebar-placement.ts` | Reads the saved sidebar placement (side, docked or floating, open, size, and now `seam` (the seam between two panes it sits on), `foldedAt` (where its folded handle was put, as shares of the window), `fit` (the person's min/max icon count) and mode `folded`). |
| `read-surface-collections.ts` | Reads the person's sidebar lists and their members. `listMadeByPerson(list)` says whether the person made a list (it carries `made_at`, written when a list is made): only such a list shows while it is empty, in the sidebar and among an empty tab's folders (`test/empty-lists-hidden.test.mjs`). |
| `apply-list-rules.ts` | The person's own lists and rows that hold or show by a rule: a list's `holds: { rules }` (it holds every row the rule holds for), `order_by` ({ path, descending }), `shown_when` (it shows only while its rule holds), and a row's `shown_when` in its place in a list. Reads them out for the caller's decider (src/workspace/sidebar-rules.mjs, the formula engine) and lays the answer over the lists; until an answer arrives nothing that shows by a rule is shown. Pure: it decides nothing and reads no clock. |

## Key types / functions

| Name | Signature / shape | Role |
|---|---|---|
| `SidebarSettings` | `Readonly<Record<string, boolean>>` | Named switches, each on unless a level turns it off. |
| `SIDEBAR_SWITCHES` | `{ removeFromList, addToList, reorder, moveBetweenLists, unpin, autoHide, position, collapse, undock, hide, resize, stayOpen }` | The switch names the sidebar itself acts on. |
| `readSidebarSettings` | `(value: unknown) => SidebarSettings \| undefined` | The true/false entries of a DATA value. |
| `mergeSidebarSettings` | `(...levels) => SidebarSettings` | Wider level first, later levels override. |
| `sidebarAllows` | `(settings, key) => boolean` | Whether a switch is on after merging. |
| `SidebarWidthRow` | `{ narrower_than_px: number; settings: SidebarSettings }` | Switches that apply below a window width. |
| `readSidebarWidthRows` | `(value: unknown) => SidebarWidthRow[]` | The well-formed width rows of a DATA value. |
| `replaceProjectedGraph` / `useProjectedGraph` | `(first: object, next: unknown) => void` / `(first: unknown) => unknown` | Replace a projected graph; follow it from a React reader. |
| `repeatsRows` | `(collection) => boolean` | Whether a list shows rows that also sit in their own lists. |
| `sidebarSettingsAtWidth` | `(rows, width) => SidebarSettings` | The switches the rows set at a width, the narrowest matching row winning. |
| `DockedListFit` | `{ open: 'beside' \| 'over'; closed: 'rail' \| 'button' }` | How the open list and the collapsed list sit against the work. |
| `dockedListFit` | `({ room, openSize, railSize, workMinimum }) => DockedListFit` | `over` when the open list would leave the work below its minimum, `button` when even the rail would; unmeasured room answers beside/rail. |
| `leavesWorkUsable` | `(room, listSize, workMinimum) => boolean` | Whether the work keeps its minimum beside a list of that size. |
| `SIDEBAR_BADGE_MARKS` / `SidebarBadgeMark` | `['number', 'dot', 'none']` | The marks a row can draw for its badge. |
| `SidebarRowShown` | `'with_label' \| 'icon_only'` | Whether the row shows its name or only its icon. |
| `readSidebarBadgeMarks` | `(value: unknown) => { fallback, kinds }` | The well-formed marks of a DATA value. |
| `sidebarBadgeMark` | `(table, kind: string \| undefined, shown) => SidebarBadgeMark` | The mark for a badge of a kind on a row shown that way. |
| `SIDEBAR_BADGE_MARK_TABLE` | `SidebarBadgeMarks` | The sidebar's own marks, read from `sidebar-badge-marks.json`. |
| `mergeSurfaceCollections` | `(projected: SurfaceCollection[], durable: SurfaceCollection[]) => SurfaceCollection[]` | The app's lists with the person's saved copies laid over them, then their own lists, each screen once. |
| `showEachSurfaceOnce` | `(collections, placedByPerson?: (list, member) => boolean) => SurfaceCollection[]` | Each screen in one list only: a row the person placed wins, otherwise the first in the order shown; a list shown twice or inside itself is read once. |
| `surfaceCollectionIds` | `(collections) => string[]` | Every list id in a tree of lists, children included. |
| `ruleListsOf` | `(collections) => RuleList[]` | Every list, at any depth, carrying `holds`, `shown_when` or a row's `shown_when`, as the decider reads it (`{ id, made_at?, holds?, shown_when?, rows_shown_when? }`). |
| `undecidedRules` | `(lists: RuleList[]) => DecidedListRules` | The answer before the decider answers: those lists and rows hidden, rule lists holding nothing. |
| `applyDecidedRules` | `(collections, decided: DecidedListRules, rows) => SurfaceCollection[]` | Hidden lists and rows gone; a rule list holds the decided rows in its `order_by`, then its child lists. |
| `orderRows` | `(rows, order?: OrderBy) => rows` | Rows by the value at a path (dates read as times), rows without one last. |
| `DecidedListRules` | `{ holds: Record<listId, rowId[]>, hidden: listId[], hidden_rows: Record<listId, rowId[]>, next_change_at: number \| null }` | What the decider answers. |

## Dependencies

**Depends on:** `sidebar-settings.ts`, `docked-list-fit.ts` and the JSON depend on nothing; `read-published-records.ts` re-exports the shared `ui` published-record readers.

**Depended on by:** `../show/use-surface-collections.ts` (merge and each screen once, the live graph, the person's rule lists), `src/workspace/sidebar-lists.ts` (`orderRows` for a list's `order_by`), `src/sidebar.mjs` (the AIs' read of the same rule lists), `test/list-rules.test.mjs`, `src/workspace/sidebar-rules-live.ts` (replaces the graph as rule lists change), `../show/DesktopSidebar.tsx` (placement controls by width; whether the docked list floats over the work), `../show/SidebarContent.tsx` and `../show/AppSidebar.tsx` (list and row switches), `../show/mount-sidebar.tsx` (sidebar-wide switches from surface input), `../show/SidebarContent.tsx` (badge marks), `test/sidebar-width-settings.test.ts`, `test/sidebar-docked-list-fit.test.ts`, `test/sidebar-badge-marks.test.ts`, `test/sidebar-each-screen-once.test.mjs`, `test/sidebar-saved-app-lists.test.mjs`.
