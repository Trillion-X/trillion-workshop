// parts/ui/show/chart/offer-chart-view.tsx
//
// PURPOSE
//   Offers a Chart view to every list (../record-views/every-list-views.ts): any list's records drawn as a chart placement
//   (chart-types.ts) whose mark, number, grouping and formula the person picks right on the chart, kept for them per list
//   as their own record (workspace-preference `chart-view:<list>`), so it is the same on every device. A list with a date
//   starts as its records over time; one without starts as its records by its first grouping field. A time chart narrows by drilling
//   into a slot and rolls up or down by bucket (ChartPlacement).
//   Imported once when the page starts (parts/ui part.json side_effects).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list or field is named: choices come from the list's own fields (dates, numbers, fields that group).
//   2. Values are read the way every view reads them (a field's factValue, else read), so a money or date field reads as
//      its number, never its drawn words.
//   3. The person's choice is a DATA row (a chart placement), the same row a screen or an arrangement places.

import React from 'react';
import { lazyPart } from '../load-later/later';
import { registerEveryListView } from '../record-views/every-list-views';
import type { RecordViewContext } from '../record-views/record-views';

// The chart's code is fetched the first time a list is drawn as a chart, never with the page.
const ListChart = lazyPart(() => import('./list-chart'), module => module.ListChart);

registerEveryListView({
  id: 'chart',
  label: 'Chart',
  icon: 'ChartColumn',
  fadeEdges: ['top', 'bottom'],
  render: (context: RecordViewContext) => <React.Suspense fallback={null}><ListChart context={context} /></React.Suspense>,
});
