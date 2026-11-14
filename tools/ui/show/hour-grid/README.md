# hour-grid

Domain-blind timed-lane grid: an hour gutter, hairline hour rows, N day lanes, an optional now line, interval pills with a colour spine, and an optional drop marker.

## Files

| File | Purpose |
|------|---------|
| `HourGrid.tsx` | The grid. Selectable lanes show a snapped pointer preview and report blank slots from pointer or keyboard. Pills are focusable `role="button"` elements; titles wrap in blocks at least 56px tall and remain truncated in shorter blocks. Short items keep a 16px visual floor so quarter-hour events stay compact in week view. Opt-in resize sliders are sibling controls so selection and resizing stay separate. `draggable` remains caller-controlled; lane/item data attributes still route existing drag/drop. |
| `neighbor.mjs` / `neighbor.d.mts` | Pure: which pill an arrow key moves focus to (`neighborKey(lanes, from, 'up' \| 'down' \| 'left' \| 'right')`): up and down walk one lane in drawn order, left and right take the pill that starts nearest in the nearest lane that has one; never wraps. Test: `test/hour-grid-neighbor.test.mjs`. |
| `index.ts` | Re-exports `HourGrid` and its types. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `HourGridProps` | `{windowStartMinute, windowEndMinute, hourHeightPx?, formatHourLabel, lanes, nowMinute?, onSelectItem?, onSelectTime?, selectionKeyboardHint?, onResizeItem?, resizeLabel?, snapMinutes?, gutterWidthPx?, minLaneWidthPx?, bannerGutterLabel?, dropMarker?, workingHours?, initialScrollMinute?, maxScrollHeight?, className?}` | `onSelectItem` and `onSelectTime` route to the caller. Blank-lane pointer selection and focused-lane arrows use the same snap interval. `onResizeItem` is called only for items marked `resizable`; preview remains local until pointer-up or keyboard confirmation. `workingHours` shades time outside the supplied local interval without removing items. |
| `HourGridWorkingHours` | `{startMinute, endMinute}` | Local minutes since midnight. An end before the start means the interval crosses midnight. |
| `HourGridLane` | `{key, headerLabel?, headerEmphasis?, items, banners?, showNowLine?}` | One lane (a day). |
| `HourGridItem` | `{key, startMinute, endMinute, column, columnCount, color?, title, subtitle?, selected?, quiet?, draggable?, resizable?, selectionControl?}` | One interval pill; overlap placement and drag/resize authorization are caller DATA. |
| `HourGridBanner` | `{key, title, color?, selected?, quiet?, startColumn?, columnSpan?, row?, selectionControl?}` | An untimed pill in the strip above the grid. Spans cross adjacent lanes in one continuous bar; absent geometry keeps each legacy banner in its own lane and local row. |
| `HourGridDropMarker` | `{laneKey, minute, label}` | Where a dragged thing would land. |

## Dependencies

**Depends on:** `../cn`, `../schedule-calendar/schedule-placement.mjs`, `../../screen-look/show/schedule-calendar.css`, React.
**Depended on by:** `../schedule-calendar` (hour lanes), `../coss/workspace-controls.tsx` (`mountHourGrid` for plain-script hosts).

Keyboard on a pill is the caller's keymap, not this file's: a caller that passes `commandRef` owns every key and is handed `focusNeighbor(key, direction)`, the one thing only the grid knows (how its pills lie in the lanes); one that passes none gets Enter and Space choosing a focused pill. `onSelectItem(key, { additive })` says when a pill was chosen with Command or Control held. `extraGutters` draw more hour columns left of the main one (other time zones, each with its heading and its own hour words); `onHourHeightChange` with `minHourHeightPx`/`maxHourHeightPx` makes a Command-drag over the hour labels report the zoom it asks for (never kept here); `bannersCollapsed` shows only the first row of the all-day strip and `collapsedBannerLabel(hidden)` counts the rest.

Blank lanes show a snapped pointer preview and can be selected by pointer or keyboard. Resize handles use pointer capture; cancel restores the starting size. The keyboard slider previews with arrows and commits with Enter/Space or cancels with Escape. Callers supply all help and handle copy.

Timed items and banners may receive a caller-owned `selectionControl` node. It is rendered beside the shared item action, so the calendar owner can supply a licensed Checkbox for explicit batch selection without changing click-to-open behavior.

Visual reference: the supplied Amie screenshot #86 shows a populated, dark seven-day grid with quiet lane rules, compact event strips, a clear weekday/date row and a task pane at roughly 23% of the working width. The shared Screen Look keeps those proportions and muted event fills without copying Amie's implementation. The current 48px hour rhythm is retained; only the oversized 22px minimum for short events was reduced.

Wrapping follows the current pill height, including its local resize preview, so resizing across the 56px threshold updates the title layout without changing the selectable button or resize slider semantics. Subtitles wait until wrapped titles have additional room.
