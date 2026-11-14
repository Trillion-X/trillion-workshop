// parts/visual-database/show/offer-views-to-every-list.tsx
//
// PURPOSE
//   Offer visual-database's views to every Trillion list: each row of source-data/views-offered-to-every-list.json
//   becomes one view in every list's view switch (parts/ui/show/record-views/every-list-views.ts), offered to a list
//   whose fields can draw it. Imported once when the page starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Adding a view is a DATA row; this file names none.
//   2. The surface's code is fetched the first time a person opens one of these views, never with the page.

import { lazyPart } from '../../ui/show/load-later/later';
import * as React from 'react';
import { registerEveryListView } from '../../ui/show/record-views/every-list-views';
import offered from 'trillion-workshop/tools/keep-lists-of-rows/source-data/views-offered-to-every-list.json';
import { listCanDraw, type OfferedViewRow } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database-input-from-list.ts';

const ListAsVisualDatabase = lazyPart(() => import('./list-as-visual-database'), module => module.default);

// What marks an item done is one setting for every view, so each row reads it.
const done = { done_tones: offered.done.tones, done_values: offered.done.values };
for (const listed of offered.views as OfferedViewRow[]) {
  const row: OfferedViewRow = { ...done, ...listed };
  registerEveryListView({
    id: row.id,
    label: row.label,
    icon: row.icon,
    fadeEdges: ['top', 'bottom'],
    offeredFor: (fields, nesting) => listCanDraw(row, fields, Boolean(nesting)),
    render: context => (
      <React.Suspense fallback={null}>
        <ListAsVisualDatabase context={context} row={row} />
      </React.Suspense>
    ),
  });
}
