// tools/read-and-edit-the-saved-configurations-others-shared/do-work/answer-the-configurations-page.mjs
//
// The saved-configurations routes (/configurations and /configurations/...), answered by old trillion's own owner:
// makeConfigurations and handleConfigurationsRequest (tools/query-and-change-list-rows/src/configurations.mjs, moved
// byte for byte from src/configurations.mjs at tag old-trillion-before-worker-retire). The engine runs this as a
// @workshop-routes tool: input { path, method, query, body, browser, records }, result { status, body, keep }.
//
// A configuration was already an own record (type record:configuration, id record:configuration:<id>), so it is the
// same record here. The caller reads the configuration records and the list records the route needs from where the
// person keeps them and hands them in as `records` ([{ id, type, value }]). The owner reads and writes its store
// synchronously; this run holds those records in `recordsInMemory`, lets the owner work on that, and answers what it
// wrote as `keep` ({ id, type, value, expected }: value null removes one, expected is the record as it was handed in,
// null for a new one) for the caller to put in its store. A store refuses a keep whose expected record has moved. A
// refused change answers no keep. The run reads and writes no store.
//
// What the old account gave the owner, and what it is here:
//   - owner (the account's network relay and profile name): the old owner's own fallback { id: 'self', name: 'You' }:
//     the local engine has no network relay, and a profile is no record this run is handed;
//   - fieldsForTarget (a `list:` target's field ids): read from that list record, when the caller hands it in;
//   - shared (configurations shared with this account by link or offer, src/native-configurations.mjs over record
//     sharing) and the time-bound context: not reachable from a run given the person's records, so those requests answer
//     the old handler's own "temporarily unavailable" (503 configuration_unavailable), never a made-up answer.
import { CONFIGURATION_TYPE, handleConfigurationsRequest, makeConfigurations } from '../../query-and-change-list-rows/src/configurations.mjs';

const LIST_ID = 'list:saved-configurations';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class Unreachable extends Error {}
const unreachable = () => { throw new Unreachable('Shared configurations are not reachable from this run.'); };
export const unreachableShares = Object.freeze({ list: unreachable, read: unreachable, readOffer: unreachable, edit: unreachable });

/**
 * The owner's synchronous record store over records already read: read, write (staged), ids (greatest id first, with
 * `before`), and scan by target (the old target index, here the configurations' own target field). `written` holds
 * each record the owner wrote, in order, last write per id winning.
 */
export function recordsInMemory(records) {
  const values = new Map(records.map(record => [record.id, { type: record.type, value: record.value }]));
  const written = new Map();
  const ofType = type => [...values.entries()].filter(([, row]) => row.type === type && row.value !== null).map(([id]) => id).sort().reverse();
  return {
    written,
    read: id => values.get(id)?.value ?? null,
    write(list) { for (const record of list) { values.set(record.id, { type: record.type, value: record.value }); written.set(record.id, record); } },
    indexReady: () => true,
    ids: (type, { limit, before } = {}) => ofType(type).filter(id => before === undefined || id < before).slice(0, limit),
    scan: (type, field, { equal = [], limit, idTo } = {}) => ofType(type)
      .filter(id => equal.includes(values.get(id).value?.[field]) && (idTo === undefined || id < idTo))
      .slice(0, limit).map(id => ({ id })),
  };
}

// The records handed in (none when left out), each checked to be { id, type, value } and held by id: a later record with
// a null value removes an earlier one, as it would in a store.
function heldOf(records) {
  if (records === undefined) return new Map();
  if (!Array.isArray(records) || !records.every(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string')) {
    throw new Error('records must be the configuration and list records read from the person\'s store, each { id, type, value }.');
  }
  const held = new Map();
  for (const record of records) {
    if (record.value === null || record.value === undefined) held.delete(record.id);
    else held.set(record.id, { type: record.type, value: record.value });
  }
  return held;
}

/** tool:answer-the-configurations-page: called as fn(input) by tools/records-door/do-work/run-an-export.mjs. */
export async function answerTheConfigurationsPage(input) {
  const { path = '', method = 'GET', query = {}, body, records } = object(input) ? input : {};
  const held = heldOf(records);
  const eeaf = recordsInMemory([...held].map(([id, { type, value }]) => ({ id, type, value })));
  const configurations = makeConfigurations({
    eeaf,
    owner: () => ({ id: 'self', name: 'You' }),
    fieldsForTarget: target => (target.startsWith('list:') ? (eeaf.read(target)?.fields ?? []).map(field => field.id) : null),
  });
  const search = new URLSearchParams(object(query) ? query : {}).toString();
  const request = new Request(`https://person${path}${search ? `?${search}` : ''}`, method === 'GET'
    ? {} : { method, headers: { 'content-type': 'application/json', 'x-trillion-app': 'person' }, body: JSON.stringify(body ?? {}) });
  const response = await handleConfigurationsRequest(configurations, request, unreachableShares, {});
  const keep = response.status < 400 ? [...eeaf.written.values()].map(record => ({ ...record, expected: held.get(record.id) ?? null })) : [];
  return { status: response.status, body: await response.json(), keep };
}
