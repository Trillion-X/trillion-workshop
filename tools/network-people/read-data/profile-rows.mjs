// tools/network-people/read-data/profile-rows.mjs
//
// The one owner of the rows a person's Network profile keeps and how a change to one is kept: the record kinds, their ids, the
// records a run is handed, and the keep of one changed row. The run reads and writes no store: the caller reads the profile rows
// it needs from its own store and hands them in as records ({ id, type, value }); a row a run changes comes back under `keep` as
// { id, type, value, expected }, where `expected` is the record as it was handed in (null for a new row), so a store refuses the
// write when that row has moved since it was read.
import { isDeepStrictEqual } from 'node:util';

export const KINDS = {
  profile: 'record:network-profile',
  label: 'record:network-label',
};

const part = value => encodeURIComponent(String(value));

/** The id of the row of `kind` made from `parts`, in the order the contract names them. */
export const rowId = (kind, ...parts) => `${KINDS[kind]}:${parts.map(part).join(':')}`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** One run's refusal in words a person's AI can read: thrown, so the container answers { error } and the run fails. */
export class NetworkRefusal extends Error {}
export const refuse = sentence => { throw new NetworkRefusal(sentence); };

/** The records a run is handed, each { id, type, value }; one that is not well formed is not there. */
export function recordsIn(input) {
  return (Array.isArray(input?.records) ? input.records : [])
    .filter(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && object(record.value));
}

/** The profile row of one person among those handed in, or null. */
export const profileOf = (records, subject) => records.find(record => record.type === KINDS.profile && record.id === rowId('profile', subject)) ?? null;

/** Every profile row handed in, as { id, value }; each profile's value names its person in `subject`. */
export const profilesIn = records => records.filter(record => record.type === KINDS.profile).map(record => ({ id: record.id, value: record.value }));

/**
 * The keep of one row a run changes: { id, type, value, expected }, where `expected` is the record as it was handed in (`handed`,
 * null when the row is new). A row that already holds this value keeps nothing: answers null.
 */
export function keepRow(kind, id, value, handed) {
  if (handed && isDeepStrictEqual(handed.value, value)) return null;
  return { id, type: KINDS[kind], value, expected: handed ? { id: handed.id, type: handed.type, value: handed.value } : null };
}
