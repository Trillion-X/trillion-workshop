// A stand-in for the person's own store, played by the test as the caller would play it: a run is given what it asks for
// (records, lists and files, answered from this store), and what it writes is kept back here. No door, no server.
import { makeHashCodeHexFromBytes } from '../../../content-identity/read-data/identity.mjs';
import { runHeld } from '../../do-work/run-held.mjs';

export function heldStore({ records = [], files = {} } = {}) {
  const rows = new Map(records.map(record => [record.id, { ...record }]));
  const bytesOf = held => (typeof held === 'string' ? Buffer.from(held, 'utf8') : Buffer.from(held.base64, 'base64'));
  const stored = new Map(Object.entries(files).map(([name, held]) => [name, bytesOf(held)]));
  const store = {
    rows,
    kept: rows,
    files: stored,
    async close() {},
    get(id) { return rows.get(id) ?? null; },
    // records:list as the store answers it: the query's type, id prefix, where and fields; greatest id first unless reverse is false.
    query(query = {}) {
      const matches = row => row.value !== null && (!query.type || row.type === query.type)
        && (!query.prefix || row.id.startsWith(query.prefix))
        && (!query.where || Object.entries(query.where).every(([name, value]) => JSON.stringify(row.value?.[name]) === JSON.stringify(value)));
      const ids = [...rows.values()].filter(matches).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (query.reverse !== false) ids.reverse();
      return ids.slice(0, query.limit ?? Infinity).map(row => (query.fields
        ? { id: row.id, type: row.type, value: Object.fromEntries(query.fields.filter(name => name in (row.value ?? {})).map(name => [name, row.value[name]])) }
        : { ...row }));
    },
    // The live rows of one kind, newest first (what the person's own list would show).
    rowsOf(type) { return store.query({ type }); },
    fileIdentity(name) { return makeHashCodeHexFromBytes(stored.get(name)); },
  };
  return store;
}

/**
 * Runs a function of this folder the way the engine and the person's AI run it: each round hands in every answer so far,
 * the run answers what it still needs, and the answers are added from the store; when a run is complete its writes are
 * kept in the store. Returns the run's answer and the number of rounds it took.
 */
export async function runKept(store, fn, given = {}, { now = () => new Date('2026-11-19T08:00:00Z'), maxRounds = 60 } = {}) {
  const answers = { records: new Map(), queries: new Map(), files: new Map() };
  for (let round = 1; round <= maxRounds; round += 1) {
    const stored = {
      records: [...answers.records.values()],
      queries: [...answers.queries.values()],
      files: Object.fromEntries(answers.files),
    };
    const answer = await runHeld((input, context) => fn(input, { ...context, now }), { ...given, stored });
    if (answer?.complete === false) {
      for (const need of answer.needs.records) {
        const row = store.get(need.id);
        answers.records.set(need.id, { id: need.id, type: row?.type ?? need.type ?? null, value: row && (!need.type || row.type === need.type) ? row.value : null });
      }
      for (const query of answer.needs.lists) {
        const key = JSON.stringify(query, Object.keys(query).sort());
        answers.queries.set(key, { query, records: store.query(query) });
      }
      for (const wanted of answer.needs.files) {
        const name = store.files.has(wanted) ? wanted : [...store.files.keys()].find(item => store.fileIdentity(item) === wanted);
        answers.files.set(wanted, name === undefined ? null : { base64: store.files.get(name).toString('base64') });
      }
      continue;
    }
    // The run is complete: keep what it wrote.
    const keep = answer?.keep ?? [];
    for (const item of keep) {
      if (item.file !== undefined) store.files.set(item.file, Buffer.from(item.base64, 'base64'));
      else if (item.value === null) store.rows.delete(item.id);
      else store.rows.set(item.id, { id: item.id, type: item.type, value: item.value });
    }
    return { answer, rounds: round, kept: keep.length };
  }
  throw new Error(`the run needed more than ${maxRounds} rounds`);
}
