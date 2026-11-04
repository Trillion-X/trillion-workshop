// The public door's rows, read from the person's Service connections list through the records door. A row carrying `rents_a_host` is a
// hosting provider (its requests are the row's own instrument_requests); one carrying `points_a_name` is a DNS
// provider; the `public-door-placement` record is where the door runs now. Credentials appear only as a vault name.
// The list is list:service-connections, its rows of type record:service-connection (tools/records-door).
export const serviceConnectionsType = 'record:service-connection';

// Every row of the list as { address: its record id, payload: its value }, in id order, so the answer does not depend on
// the order the door pages them.
async function readAll(records) {
  const things = [];
  for await (const record of records.list({ type: serviceConnectionsType })) if (record.value) things.push({ address: record.id, payload: record.value });
  return { things: things.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)) };
}

async function rowsWith(block, records) {
  const things = (await readAll(records)).things;
  return things.map(t => t.payload).filter(p => p[block]).map(p => {
    const placed = p.credential_injections?.[0]?.placement;
    return { id: p.connection_id?.replace(/^service_connection:/, '') ?? p.id, name: p.name, ...p[block],
      requests: p.instrument_requests ?? {}, auth: placed ? { header: placed.name, prefix: placed.prefix ?? '' } : null };
  });
}
function one(rows, id, what) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`No ${what} row is named ${JSON.stringify(id)}; the rows are ${rows.map(r => r.id).join(', ')}.`);
  return row;
}
export const hostingProviders = records => rowsWith('rents_a_host', records);
export const dnsProviders = records => rowsWith('points_a_name', records);
export const hostingProvider = async (id, records) => one(await hostingProviders(records), id, 'hosting provider');
export const dnsProvider = async (id, records) => one(await dnsProviders(records), id, 'DNS provider');
const isDoor = p => p.kind === 'public-door-placement' && p.id === 'current';
export const currentDoor = async records => one((await readAll(records)).things.map(t => t.payload).filter(isDoor), 'current', 'door placement');

/** Replace the current-door record, conditioned on the value just read (a row changed meanwhile is refused, not written
 *  over); every other record is kept as it was. */
export async function saveCurrentDoor(door, records) {
  const all = await readAll(records), thing = all.things.find(t => isDoor(t.payload)), expected = { type: serviceConnectionsType, value: thing.payload };
  thing.payload = { ...door, kind: 'public-door-placement', id: 'current' };
  await records.write([{ id: thing.address, type: serviceConnectionsType, value: JSON.parse(JSON.stringify(thing.payload)), expected }]);
  return thing.payload;
}
