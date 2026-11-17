// The public door's rows, taken from the values of the person's Service connections rows (record:service-connection) that
// the caller read from that list and hands in as `connections`. A row carrying `rents_a_host` is a hosting provider (its
// requests are the row's own instrument_requests); the
// `public-door-placement` row with id `current` is where the door runs now. Credentials appear only as a vault name.
// Nothing here reads or writes a list.

function rowsWith(block, connections) {
  return connections.filter(p => p?.[block]).map(p => {
    const placed = p.credential_injections?.[0]?.placement;
    return { id: p.connection_id?.replace(/^service_connection:/, '') ?? p.id, name: p.name, ...p[block],
      requests: p.instrument_requests ?? {}, auth: placed ? { header: placed.name, prefix: placed.prefix ?? '' } : null };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function one(rows, id, what) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`No ${what} row is named ${JSON.stringify(id)}; the rows handed in are ${rows.map(r => r.id).join(', ') || 'none'}.`);
  return row;
}
export const hostingProviders = connections => rowsWith('rents_a_host', connections);
export const hostingProvider = (id, connections) => one(hostingProviders(connections), id, 'hosting provider');
export const currentDoor = connections => one(connections.filter(p => p?.kind === 'public-door-placement' && p.id === 'current'), 'current', 'door placement');
