// The public door's rows, read from this part's one registry (../records.json). A row carrying `rents_a_host` is a
// hosting provider (its requests are the row's own instrument_requests); one carrying `points_a_name` is a DNS
// provider; the `public-door-placement` record is where the door runs now. Credentials appear only as a vault name.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const serviceConnectionRecordsFile = new URL('../records.json', import.meta.url);
const readAll = (file = serviceConnectionRecordsFile) => JSON.parse(readFileSync(file, 'utf8'));

function rowsWith(block, file) {
  const things = readAll(file).things, named = new Map(things.map(t => [t.address, t.payload.name]));
  return things.map(t => t.payload).filter(p => p[block]).map(p => {
    const placed = p.credential_injections?.[0]?.placement;
    return { id: p.connection_id?.replace(/^service_connection:/, '') ?? p.id, name: named.get(p.connection_ref) ?? p.name, ...p[block],
      requests: p.instrument_requests ?? {}, auth: placed ? { header: placed.name, prefix: placed.prefix ?? '' } : null };
  });
}
function one(rows, id, what) {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`No ${what} row is named ${JSON.stringify(id)}; the rows are ${rows.map(r => r.id).join(', ')}.`);
  return row;
}
export const hostingProviders = file => rowsWith('rents_a_host', file);
export const dnsProviders = file => rowsWith('points_a_name', file);
export const hostingProvider = (id, file) => one(hostingProviders(file), id, 'hosting provider');
export const dnsProvider = (id, file) => one(dnsProviders(file), id, 'DNS provider');
const isDoor = p => p.kind === 'public-door-placement' && p.id === 'current';
export const currentDoor = file => one(readAll(file).things.map(t => t.payload).filter(isDoor), 'current', 'door placement');

/** Replace the current-door record in place (atomic rename); every other record is kept as it was, in order. */
export function saveCurrentDoor(door, file = serviceConnectionRecordsFile) {
  const all = readAll(file), thing = all.things.find(t => isDoor(t.payload));
  thing.payload = { ...door, kind: 'public-door-placement', id: 'current' };
  const next = `${file instanceof URL ? file.pathname : file}.next`;
  writeFileSync(next, `${JSON.stringify(all, null, 1)}\n`);
  renameSync(next, file);
  return thing.payload;
}
