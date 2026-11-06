// tools/keep-lists-of-rows/test-support/door-over-a-record-book.mjs
//
// For tests only: a records door (tools/records-door read-data/records-door.mjs recordsDoorFromCall, the real client)
// whose records are a synchronous record book a test already holds (`eeaf`: read, ids, typeOf, write, atomically). A
// test that checks the book directly sees what the door wrote, so a test written for the lists over the book proves
// the same lists over the door (lists-over-the-records-door.mjs listsThroughTheDoor). It answers the door's
// records:read, records:list (greatest id first, in pages, after an id) and records:write (each record's `expected`
// checked before anything is written, all in one atomic step), and records:read with `at` from the book's readAt when it
// keeps versions (records-fake does). It is not a store: the book keeps the records.
import { isDeepStrictEqual } from 'node:util';
import { recordsDoorFromCall, RecordsDoorError } from '../../records-door/read-data/records-door.mjs';

export function doorOverARecordBook(eeaf, { pageRows = 50 } = {}) {
  const held = id => {
    const value = eeaf.read(id);
    if (value === null || value === undefined) return null;
    return { type: eeaf.typeOf?.(id) ?? null, value };
  };
  const calls = [];
  const atomically = change => (typeof eeaf.atomically === 'function' ? eeaf.atomically(change) : change());
  const door = recordsDoorFromCall(async (method, input) => {
    calls.push(method);
    if (method === 'records:read' && input.at !== undefined) {
      if (typeof eeaf.readAt !== 'function') throw new Error('This record book keeps no history.');
      const then = eeaf.readAt(input.id, input.at);
      const same = then.value !== null && (then.type === null || then.type === input.type);
      return { id: input.id, type: input.type, value: same ? structuredClone(then.value) : null, complete: then.complete, kept_from: then.kept_from };
    }
    if (method === 'records:read') {
      const one = held(input.id);
      return { id: input.id, type: input.type, value: one && (one.type === null || one.type === input.type) ? structuredClone(one.value) : null };
    }
    if (method === 'records:list') {
      const ids = eeaf.ids(input.type, input.prefix ? { prefix: input.prefix } : undefined).filter(id => !input.prefix || id.startsWith(input.prefix)).sort().reverse();
      const from = input.after === undefined ? 0 : ids.indexOf(input.after) + 1;
      const size = Math.min(input.limit ?? pageRows, pageRows);
      const page = ids.slice(from, from + size);
      return { records: page.map(id => ({ id, type: input.type, value: structuredClone(eeaf.read(id)) })), next: from + size < ids.length ? page.at(-1) : null };
    }
    if (method === 'records:write') {
      return atomically(() => {
        for (const item of input.records) {
          if (item.expected === undefined) continue;
          const now = held(item.id);
          const fine = item.expected === null ? now === null
            : now !== null && (now.type === null || now.type === item.expected.type) && isDeepStrictEqual(now.value, item.expected.value);
          if (!fine) throw new RecordsDoorError('original_command_conflict', 'changed', 'not_started');
        }
        eeaf.write(input.records.map(({ expected: _expected, ...item }) => item), { actor: { by: 'records-door' } });
        return { changed: input.records.length, write_count: input.records.length };
      });
    }
    throw new Error(`unexpected ${method}`);
  }, { resource: '@own-records' });
  return { door, calls };
}
