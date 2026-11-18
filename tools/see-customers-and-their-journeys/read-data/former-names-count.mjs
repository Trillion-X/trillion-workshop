// Source-first port; configuration is supplied by authenticated list rows.

export function createFormerNamesCounter({ serverEvent, formerNames }) {
// A former tool or agent id that still reaches the server is counted operator-wide (records/interactions.json
// former_id_used), at most once per id per `note_every_minutes` in this isolate, so the service watch
// former-names-retire can hand the row's removal once nothing sends it (src/renamed-tools.json).
// Only the id from the closed table is counted, never the account or the request.

const noted = new Map();

/** The former ids not counted in this isolate within the last `note_every_minutes`, as the events the caller keeps (or null
 *  when nothing was due). */
function countFormerIds(ids, now = Date.now()) {
  const every = formerNames().note_every_minutes * 60_000;
  const known = new Set(formerNames().ids);
  const due = [...new Set(ids)].filter(id => known.has(id) && !(now - (noted.get(id) ?? -Infinity) < every));
  if (!due.length) return null;
  for (const id of due) noted.set(id, now);
  return due.map(former_id => serverEvent('former_id_used', { former_id }));
}

return { countFormerIds };
}
