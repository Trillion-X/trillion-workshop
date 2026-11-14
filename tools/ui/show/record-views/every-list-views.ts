// parts/ui/show/record-views/every-list-views.ts
//
// PURPOSE
//   The views a part offers to every list beside the list's own (visual-database's timeline, swimlanes, outline,
//   tree and summary of any records). A part registers its views once when the page starts; every RecordViews that
//   offers more than one view then offers each registered view its fields can draw.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file holds only the offer: it imports no view, so registering costs the page nothing until a list draws.
//   2. One id is one view: registering an id again replaces the earlier view.
//   3. A view that names `offeredFor` is offered only to lists whose fields (and nesting) it holds for.

import type {FieldDescriptor, RecordNesting, RecordView} from './record-views'

const offered: RecordView[] = []

/** Offer a view to every list. Register before lists draw: a list reads the offer when it draws its view switch. */
export function registerEveryListView(view: RecordView) {
  const at = offered.findIndex(option => option.id === view.id)
  if (at >= 0) offered[at] = view
  else offered.push(view)
}

/** The registered views a list with these fields (and this nesting) can draw, in the order they were registered. */
export function viewsOfferedToEveryList(fields: FieldDescriptor[], nesting?: RecordNesting): RecordView[] {
  return offered.filter(view => !view.offeredFor || view.offeredFor(fields, nesting))
}
