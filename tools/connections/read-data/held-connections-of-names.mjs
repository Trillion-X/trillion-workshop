// tools/connections/read-data/held-connections-of-names.mjs
//
// PURPOSE
//   The connections a vault holds, from its held names alone: [{ connection_id, fields }], the `held_connections` list
//   tool:list-connections and tool:find-the-account-of-a-service take. A page reads the names (secrets:names at the
//   account's door, names only) and hands this list on, so it can ask which account of a service it means before it
//   starts a run (the engine boundary audit moved that choice out of the engine, Nov 21 2026).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names only: it reads the names it is handed, never a value, and a name that is not a connection's is left out.
//   2. The naming is held-connections-of-names.json's, the one connect-service.ts writes; nothing here names a service.
//   3. Runs in a page and in node alike: no file read, no network.
import settings from './held-connections-of-names.json' with { type: 'json' };

const HEX = /^(?:[0-9a-f]{2})+$/;

/** The text a hex of UTF-8 bytes writes, or null when it is not one. */
function unhex(hex) {
  if (!HEX.test(hex)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16)));
  } catch {
    return null;
  }
}

/** [{ connection_id, fields }] in connection id order, from the vault's held names; a connection held whole has no fields. */
export function heldConnectionsOfNames(names) {
  const held = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== 'string' || !name.startsWith(settings.prefix)) continue;
    const [connectionHex, fieldHex, ...rest] = name.slice(settings.prefix.length).split(settings.field_separator);
    const connectionId = unhex(connectionHex);
    const field = fieldHex === undefined ? undefined : unhex(fieldHex);
    if (!connectionId || rest.length || field === null) continue;
    const fields = held.get(connectionId) ?? new Set();
    if (field) fields.add(field);
    held.set(connectionId, fields);
  }
  return [...held].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([connection_id, fields]) => ({ connection_id, fields: [...fields].sort() }));
}
