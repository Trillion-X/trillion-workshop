// tools/keep-lists-of-rows/lists-over-the-records-door.mjs
//
// PURPOSE
//   Runs code written for the old synchronous record book (the `eeaf` that lists.mjs makeLists and the owners built on
//   it read: read, readMany, ids, typeOf, write, atomically) over the person's own records door, which answers
//   asynchronously. Nothing here decides anything a list decides: the moved code runs unchanged over what the door holds.
//
// HOW
//   The work runs in passes over what has been read so far. A read of an id not yet read, a listing of a kind (and
//   prefix) not yet listed, or a write to an id not yet read, is noted and answered as absent for this pass. After the
//   pass every noted id is read and every noted listing listed through the door, and the work runs again from the
//   start. The pass that notes nothing is the answer: its writes are sent through the door in one write, each record
//   with `expected` set to what was read (null when it was absent), so a record changed since it was read is never
//   written over (the door refuses the whole write). A pass that threw while something was still unread is not an
//   answer; the same throw on a pass with nothing unread is.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The door is the one store. Nothing read here is kept past the request; nothing is written but by the door.
//   2. Every write is conditional on the value the pass read; a pass that read nothing of an id never writes it.
//   3. A pass is deterministic over the same reads: new ids are handed out in the same order on every pass (`newId`)
//      and the moment is fixed for the request, so the answer is the work's answer over the records as read.
//   4. Each record's kind is named from its id by `typeOf`; the door refuses anything outside the run's rights.
//   5. A declared index is not ready here (indexReady false), so the moved code takes its unindexed reads.
//
import { writeBatches } from '../records-door/read-data/write-batches.mjs';

const clone = value => (value === null || value === undefined ? null : structuredClone(value));
const MOST_PASSES = 64;
const MOST_LISTED = 5000;

export class UnreadRecordsError extends Error {}

/**
 * `work(eeaf, { newId })` run over the person's records through `door` until every record it reads has been read.
 * `typeOf(id)` names a record's kind from its id. Answers `{ result, written }`; throws the work's own error.
 */
export async function overTheRecordsDoor(door, work, { typeOf, mostPasses = MOST_PASSES, key } = {}) {
  if (typeof typeOf !== 'function') throw new TypeError('typeOf names each record kind from its id.');
  const held = new Map(); // id -> { type, value } (value null: read and absent)
  const listed = new Set(); // `${type}\u0000${prefix}`
  const minted = [];
  for (let pass = 0; pass < mostPasses; pass += 1) {
    const unreadIds = new Set();
    const unlisted = new Map();
    const written = new Map(); // id -> { type, value }
    let minting = 0;
    const current = id => (written.has(id) ? written.get(id) : held.get(id));
    const covered = (type, prefix) => [...listed].some(entry => {
      const [kind, from] = entry.split('\u0000');
      return kind === type && prefix.startsWith(from);
    });
    const listedId = id => covered(typeOf(id), id);
    const eeaf = {
      read(id) {
        const one = current(id);
        if (one) return clone(one.value);
        if (!listedId(id)) unreadIds.add(id);
        return null;
      },
      readMany(ids) { return new Map(ids.map(id => [id, eeaf.read(id)])); },
      ids(type, { prefix = '', before, limit } = {}) {
        if (!covered(type, prefix)) { unlisted.set(`${type}\u0000${prefix}`, { type, prefix }); return []; }
        const ids = new Set([...held.keys(), ...written.keys()]);
        const found = [...ids].filter(id => typeOf(id) === type && id.startsWith(prefix) && current(id)?.value !== null && current(id) !== undefined
          && (before === undefined || id < before)).sort();
        return limit === undefined && before === undefined ? found : found.reverse().slice(0, Math.max(1, Math.floor(Number(limit) || 1000)));
      },
      typeOf: id => current(id)?.value ? current(id).type : null,
      write(rows) {
        for (const row of rows) {
          if (typeof row?.id !== 'string' || !row.id) throw new TypeError('A record needs an id.');
          if (!held.has(row.id) && !listedId(row.id)) unreadIds.add(row.id);
          written.set(row.id, { type: row.type ?? typeOf(row.id), value: clone(row.value) });
        }
      },
      atomically: change => change(),
      transaction: change => change(),
      indexReady: () => false,
      forgetCached() {},
    };
    const newId = () => {
      if (minting >= minted.length) minted.push(crypto.randomUUID());
      return minted[minting++];
    };
    let result, failed = null;
    try { result = await work(eeaf, { newId }); }
    catch (error) { failed = error; }
    if (!unreadIds.size && !unlisted.size) {
      if (failed) throw failed;
      const records = [...written].filter(([id, one]) => JSON.stringify(one.value) !== JSON.stringify(held.get(id)?.value ?? null))
        .map(([id, one]) => {
          const before = held.get(id);
          return { id, type: one.type, value: one.value, expected: before?.value ? { type: before.type, value: before.value } : null };
        });
      for (const batch of records.length ? writeBatches(records, { rows: 256, bytes: 60_000 }) : []) await door.write(batch, { key: key ? `${key}:${batch[0].id}` : undefined });
      return { result, written: records.map(record => record.id) };
    }
    for (const id of unreadIds) {
      const one = await door.readRecord(typeOf(id), id);
      held.set(id, one ? { type: one.type, value: one.value } : { type: typeOf(id), value: null });
    }
    for (const { type, prefix } of unlisted.values()) {
      let count = 0;
      for await (const record of door.list({ type, ...(prefix ? { prefix } : {}) })) {
        if (count++ >= MOST_LISTED) throw new UnreadRecordsError(`More than ${MOST_LISTED} records of ${type} would be read at once.`);
        held.set(record.id, { type: record.type ?? type, value: clone(record.value) });
      }
      listed.add(`${type}\u0000${prefix}`);
    }
  }
  throw new UnreadRecordsError('The records this asked for kept changing as they were read; try again.');
}

/** A record's kind from its id, as the lists keep them: `record:<row type>:<id>` is `record:<row type>`; any other id
 *  is the longest of `kinds` it starts with (followed by a colon), else its first segment. */
export const kindOfId = (kinds = []) => {
  const longestFirst = [...kinds].sort((a, b) => b.length - a.length);
  return id => {
    if (id.startsWith('record:')) return `record:${id.split(':')[1]}`;
    return longestFirst.find(kind => id.startsWith(`${kind}:`)) ?? id.split(':')[0];
  };
};
