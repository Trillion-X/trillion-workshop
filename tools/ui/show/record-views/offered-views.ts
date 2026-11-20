//
// PURPOSE
//   The views a list offers in its view switch, in the order its own row names them. A list names the view ids it offers
//   (its definition's `offered_views`); the record views keep only those, in that order, from the views they would offer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Named ids only: a view not named is not offered, whatever else the list could draw.
//   2. An id named twice, or an id no offered view has, is left out; the list draws what it can, never an error.
//   3. Nothing named (undefined or empty) offers every view, as before: the caller keeps the whole switch.

/** The views to offer: every view when `ids` names none, else the named ones, in the order named. */
export function pickOfferedViews<T extends { id: string }>(views: readonly T[], ids: readonly string[] | undefined): T[] {
  if (!ids?.length) return [...views]
  return [...new Set(ids)].flatMap(id => views.filter(view => view.id === id).slice(0, 1))
}
