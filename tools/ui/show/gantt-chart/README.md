# gantt-chart/

Bars on a time axis: a name column that stays in view, a two-row heading (months, then days or weeks), faint weekend bands, a line for today, one bar per record row and curves between bars that follow one another. Product-neutral: it draws rows, bars and an axis already worked out and says no words of its own.

## Files

| File | Purpose |
|------|---------|
| `GanttChart.tsx` | The component: a sticky names column and the time pane in one scroller, so the names cannot drift from their rows. Opens scrolled to today, and again when `resetKey` changes. |
| `index.ts` | Barrel. |

Its look is `parts/screen-look/show/gantt-chart.css` (every colour a look token; today in the calendar's own today colour).

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `GanttRow` | `{key, kind: 'group' \| 'record', label, count?, bar?: {left, width, color, clipped, edit?: 'move' \| 'resize' \| 'refused'} \| null, barText?}` | One row: a heading that opens a group, or a record (a record with no `bar` has no dates and is listed quietly). |
| `GanttAxis` | `{width, dayPx, months, ticks, weekends, weekLines, todayLeft}` | The heading rows, weekend and week-line positions and today's line, all in pixels. |
| `GanttJoin` | `{key, d, outOfOrder}` | An SVG curve; `outOfOrder` draws it dashed. |
| `GanttChart` | `forwardRef<GanttChartHandle, GanttChartProps>` | Draws them; `ref.scrollToToday(behavior)` goes to today. A bar whose `edit` allows it is dragged by its body or an end, or nudged by the arrow keys (Shift the last day, Alt the first); the chart reports whole days through `onReschedule` and writes nothing, and a bar that may not change says so through `onRefused`. Bars and names are focusable `role="button"` elements, pressed by Enter or Space as the hour grid's pills are. |

## Dependencies

**Depends on:** React and `screen-look/show/gantt-chart.css`.
**Depended on by:** `trillion-workshop/tools/keep-lists-of-rows/show/views/ScheduleView.tsx` (the Gantt view every list holding a date is offered); the `ui` barrel.

## Why This Design?

The geometry (which days a bar covers, the axis, the curves) is pure and lives with the data in `trillion-workshop/tools/keep-lists-of-rows/read-data/schedule-bars.ts`, so this component is only a drawing of what it is handed and any list, plan or schedule can use it.