// parts/ui/show/region-map/offer-region-map-view.tsx
//
// PURPOSE
//   Offers a Region map view to every list (../record-views/every-list-views.ts), the way offer-chart-view.tsx offers the
//   chart: a saved view whose display is { as: 'region-map', settings } draws the list's records on that map
//   (list-region-map.tsx). The map, its regions and the field that names each record's region are the view's own DATA.
//   Imported once when the page starts (parts/ui part.json side_effects).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or shape is named: it is offered to every list, and a view with no map of its own says what it needs.
//   2. The code is fetched the first time a list is drawn this way, never with the page.

import React from 'react';
import { lazyPart } from '../load-later/later';
import { registerEveryListView } from '../record-views/every-list-views';
import type { RecordViewContext } from '../record-views/record-views';

const ListRegionMap = lazyPart(() => import('./list-region-map'), module => module.ListRegionMap);

registerEveryListView({
  id: 'region-map',
  label: 'Region map',
  icon: 'Map',
  fadeEdges: ['top', 'bottom'],
  render: (context: RecordViewContext) => <React.Suspense fallback={null}><ListRegionMap context={context} /></React.Suspense>,
});
