// src/workspace/starting-screens.mjs
//
// PURPOSE
//   The screens the workspace opens when nothing else is open (a page that opens at its address with no screen named,
//   or an address that names no screen): the starting screens the DATA names (surfaces.json `open_at_start`) that this
//   person is offered, else the first screen offered and listed in the sidebar. The panel is never left empty.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A starting screen is opened only when this person is offered it: a row a show rule hides (`listed: false`) or the
//      offer does not hold is never opened.
//   2. Nothing here names a screen: the starting list is DATA, and the fallback is the first row offered, in the offer's order.

/** The ids to open first, from the DATA's starting list and the rows this person is offered. */
export function startingScreenIds(startingIds, offered) {
  const listed = offered.filter(row => row && typeof row.id === 'string' && row.listed !== false);
  const offeredIds = new Set(listed.map(row => row.id));
  const starting = (startingIds ?? []).filter(id => offeredIds.has(id));
  if (starting.length) return starting;
  return listed.length ? [listed[0].id] : [];
}
