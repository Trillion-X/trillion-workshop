// tools/connections/do-work/list-connections.mjs
//
// PURPOSE
//   tool:list-connections: the services this account is connected to, one row per connection (service, vendor,
//   account name, status, can_send, connected_at, last_checked, connected_by), as old trillion's held-values `list`
//   answered it (src/held-values.mjs before 4ffa1dc4a2, the operation the row tool:list-connections ran) for the
//   Connections screen, Business and every reader of "which services did this person connect".
//
//   Ported from that operation. Where its two sources live on today's engine:
//     - the summary rows (old src/connection-summaries.mjs, one row a connection "as the listing shows it") are the
//       person's own `connection` records (id `connection:` + the connection id, encoded as a URL component; the same
//       records tools/social-posts reads), each read through the records door;
//     - the facts a row was made from until then (old connectionFacts over workshop facts) are, for a connection that
//       has no record, what only the engine's vault knows: that the connection holds values. The account files door's
//       `held_connections` read answers that from the vault's names alone ({ connection_id, fields }), never a value.
//       Such a row is made by the old connectionSummaryOf from what is known (its id, its vendor from the id, its
//       service's name from that service's descriptor); a fact that is not known (its status, when it was connected,
//       a check, who connected it) is left out, never guessed.
//   A store whose summary rows were not all made answered from the facts (`filled()`); here the rows are all made when
//   every connection the vault holds has its record, and until then a connection with no record is made from what
//   the vault's names say. A recorded connection whose values were removed (disconnected) stays listed, as its facts
//   did. The vault's read failing fails the list: a list that cannot say which connections hold values is not
//   answered as having none.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read only: it reads records and the vault's names, and writes, checks and sends nothing.
//   2. No value ever leaves: a row is the summary's own fields, never a record spread whole (connection-records.mjs).
//   3. Names no service: a service's name is its descriptor's (tools/connect-a-service-and-seal-its-key/records.json).
//   4. One row a connection, in connection id order (old connection_summaries rows()).
import { readFileSync } from 'node:fs';
import { connectionIdFromRecord, connectionSummaryOf } from '../../find-and-keep-my-connections/src/connection-records.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('./list-connections.json', import.meta.url), 'utf8'));
const SERVICES = new URL('../../connect-a-service-and-seal-its-key/records.json', import.meta.url);

// The fields a summary row carries (old connectionSummaryOf), read from a record by name and never spread whole.
const TEXT = ['connection_id', 'service', 'vendor', 'account_label', 'status', 'connected_at', 'connected_by'];
function rowOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.connection_id !== 'string' || !value.connection_id) return null;
  const row = Object.fromEntries(TEXT.filter(field => typeof value[field] === 'string' && value[field]).map(field => [field, value[field]]));
  row.can_send = value.can_send === true;
  row.grant_scopes_known = value.grant_scopes_known === true;
  if (row.grant_scopes_known) row.grant_scopes = Array.isArray(value.grant_scopes) ? value.grant_scopes.filter(scope => typeof scope === 'string') : [];
  if (value.capabilityChoices && typeof value.capabilityChoices === 'object' && !Array.isArray(value.capabilityChoices)) row.capabilityChoices = value.capabilityChoices;
  if (value.last_checked && typeof value.last_checked === 'object' && !Array.isArray(value.last_checked)) row.last_checked = value.last_checked;
  return row;
}

// The service a held connection is of: `<prefix><vendor>` or `<prefix><vendor>:<account>` (the engine's
// src/tool_runs/tools.rs connection_of and the connect tools' deriveConnectionInstanceId), null for any other id.
const vendorOf = id => (id.startsWith(SETTINGS.connection_id_prefix) ? id.slice(SETTINGS.connection_id_prefix.length).split(':')[0] || null : null);

/** Each service's name by its vendor, from the service-connection descriptors. */
export function serviceNames(services = JSON.parse(readFileSync(SERVICES, 'utf8'))) {
  return new Map(services.things.map(thing => thing.payload).filter(payload => payload?.kind === 'service-connection-descriptor')
    .map(payload => [payload.vendor, payload.name]));
}

/** The summary rows (the person's `connection` records) and the facts (the vault's held connections) as old list read them. */
export function connectionSources({ records, held, names = serviceNames() }) {
  const rows = new Map();
  for (const record of records) {
    const row = rowOf(record?.value);
    // A record names its own connection: its id is the connection's record reference.
    if (row && connectionIdFromRecord(record.id) === row.connection_id) rows.set(row.connection_id, row);
  }
  const byId = (a, b) => (a.connection_id < b.connection_id ? -1 : a.connection_id > b.connection_id ? 1 : 0);
  const summaries = {
    filled: () => held.every(item => rows.has(item.connection_id)),
    rows: () => [...rows.values()].sort(byId),
  };
  const facts = {
    // One item a connection: its record's row, or what the vault's names say of it.
    list: () => [...new Set([...rows.keys(), ...held.map(item => item.connection_id)])].sort().map(id => {
      if (rows.has(id)) return { row: rows.get(id) };
      const vendor = vendorOf(id);
      return { id, serviceName: names.get(vendor) ?? vendor ?? id, serviceVendor: vendor ?? undefined };
    }),
  };
  const shown = item => item.row ?? connectionSummaryOf(item, {});
  return { summaries, facts, shown };
}

/** The vault's held connections, from the account files door's read of its names: [{ connection_id, fields }]. */
async function heldOf(door) {
  const answer = await door.files(SETTINGS.held_operation, {});
  if (!Array.isArray(answer?.connections)) throw new Error('The connections this account holds could not be read.');
  return answer.connections.filter(item => typeof item?.connection_id === 'string' && item.connection_id);
}

/** tool:list-connections: {} → { connections }, one row a connection in connection id order. */
export async function listConnections(input = {}, { door, names } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Send {}: this lists every connection.');
  const records = [];
  for await (const record of door.list({ type: SETTINGS.record_type })) records.push(record);
  const { summaries, facts, shown } = connectionSources({ records, held: await heldOf(door), ...(names ? { names } : {}) });
  // From the summary rows once they are all made (src/connection-summaries.mjs), from the facts until then.
  return { connections: summaries?.filled() ? summaries.rows() : facts.list().map(shown) };
}
