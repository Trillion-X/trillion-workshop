// parts/visual-database/show/list-as-visual-database.tsx
//
// PURPOSE
//   One visual-database view (timeline, swimlanes, outline, tree, summary) of any Trillion list: the list's records
//   after its search and filters, read once into the visual-database model and drawn by the ported surface itself
//   (VisualDatabaseSurface), inside the list's own view switch.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The surface is drawn as a section of the list: the list's toolbar is the one search and view switch.
//   2. Nothing here draws a record; the ported surface draws every one.
//   3. The list's zoom step (context.detail, moved by a pinch on the list) is handed to the surface as `detailFields`
//      and to the model's input, so every view says less or more about each record with the same steps.
//   4. A list that keeps changes (context.write) gets the surface's every edit: its writes reach the list through
//      do-work/list-record-writer.ts; a list without it is drawn read-only.

import * as React from 'react';
import { VisualDatabaseSurface } from './VisualDatabaseSurface';
import { decodeVisualDatabaseModel } from '../read-data/visual-database';
import { visualDatabaseInputFromList, type ListContext, type OfferedViewRow } from '../read-data/visual-database-input-from-list';
import { listKeeper } from '../do-work/list-record-writer';
import listSettlement from '../source-data/list-mutation-settlement.json';
import { registerMutationNotifier } from './field-editors';
import { notify } from '../../ui/show/coss/notifications';

// New records' addresses are minted from this, and the list keeps each new row under the address it was given.
const LIST_RECORD_TARGET = { addressPrefix: 'list-record' };

export default function ListAsVisualDatabase({ context, row }: { context: ListContext; row: OfferedViewRow }) {
  const model = React.useMemo(
    () => decodeVisualDatabaseModel(visualDatabaseInputFromList(context, row)),
    [context.records, context.fields, context.label, context.identify, context.nesting, context.write, context.detail?.fields, context.groupLevels, row],
  );
  const write = context.write;
  // What the surface says about each change (saved, created, moved, or why it could not be) reaches the page's
  // notifications while a list that keeps changes is drawn.
  React.useEffect(() => {
    if (!write) return undefined;
    registerMutationNotifier({ success: message => notify(message), error: message => notify(message, { kind: 'error' }) });
    return () => registerMutationNotifier(null);
  }, [write !== undefined]);
  // A list that keeps changes is written through one keeper for as long as it is drawn (so its changes keep one
  // order), reading the list as it is now; a list that also nests moves records in its nesting.
  const now = React.useRef(context);
  now.current = context;
  const keeper = React.useMemo(() => (write ? listKeeper(() => now.current) : null), [write !== undefined]);
  return (
    <VisualDatabaseSurface
      model={model}
      presentation="section"
      initialViewId={row.id}
      {...(context.detail ? { detailFields: context.detail.fields } : {})}
      {...(keeper ? { writeRecord: keeper.writeRecord, recordTarget: LIST_RECORD_TARGET, mutationSettlementPolicy: listSettlement } : {})}
      {...(keeper && context.nesting ? { onPlaceRecord: keeper.place } : {})}
      {...(context.open ? { onSelectNode: context.open } : {})}
    />
  );
}
