// tools/read-and-edit-the-saved-configurations-others-shared/do-work/answer-the-configurations-page.mjs
//
// The saved-configurations routes (/configurations and /configurations/...), answered by old trillion's own owner:
// makeConfigurations and handleConfigurationsRequest (tools/query-and-change-list-rows/src/configurations.mjs, moved
// byte for byte from src/configurations.mjs at tag old-trillion-before-worker-retire), over the person's own records
// through the run's records door. The engine runs this as a @workshop-routes tool: input { path, method, query, body,
// browser }, result { status, body }.
//
// A configuration was already an own record (type record:configuration, id record:configuration:<id>), so it is the
// same record here. The owner reads and writes its store synchronously; this run reads every configuration record and
// the Saved configurations list once through the door into `recordsInMemory`, lets the owner work on that, and writes
// what it wrote back in one door write. A refused change writes nothing.
//
// What the old account gave the owner, and what it is here:
//   - owner (the account's network relay and profile name): the old owner's own fallback { id: 'self', name: 'You' }:
//     the local engine has no network relay, and a profile is no record this run is handed;
//   - fieldsForTarget (a `list:` target's field ids): read from that list record (kind `list`);
//   - shared (configurations shared with this account by link or offer, src/native-configurations.mjs over record
//     sharing) and the time-bound context: not reachable from a records-door run, so those requests answer the old
//     handler's own "temporarily unavailable" (503 configuration_unavailable), never a made-up answer.
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

async function listAll(door, query) {
  const found = [];
  for await (const record of door.list(query)) found.push(record);
  return found;
}

/** tool:answer-the-configurations-page: run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }). */
export async function answerTheConfigurationsPage(input, { door }) {
  const { path = '', method = 'GET', query = {}, body } = object(input) ? input : {};
  const kept = await listAll(door, { type: CONFIGURATION_TYPE });
  const list = await door.read('list', LIST_ID);
  const eeaf = recordsInMemory([...kept, ...(list ? [{ id: LIST_ID, type: 'list', value: list }] : [])]);
  const lists = new Map();
  for (const target of new Set([body?.target, ...kept.map(record => record.value?.target)].filter(target => typeof target === 'string' && target.startsWith('list:') && target !== LIST_ID))) {
    lists.set(target, await door.read('list', target).catch(() => null));
  }
  const configurations = makeConfigurations({
    eeaf,
    owner: () => ({ id: 'self', name: 'You' }),
    fieldsForTarget: target => (target.startsWith('list:') ? ((target === LIST_ID ? eeaf.read(target) : lists.get(target))?.fields ?? []).map(field => field.id) : null),
  });
  const search = new URLSearchParams(object(query) ? query : {}).toString();
  const request = new Request(`https://person${path}${search ? `?${search}` : ''}`, method === 'GET'
    ? {} : { method, headers: { 'content-type': 'application/json', 'x-trillion-app': 'person' }, body: JSON.stringify(body ?? {}) });
  const response = await handleConfigurationsRequest(configurations, request, unreachableShares, {});
  if (response.status < 400 && eeaf.written.size) await door.write([...eeaf.written.values()]);
  return { status: response.status, body: await response.json() };
}
