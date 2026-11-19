// src/workspace/records-door-seeded.ts
//
// PURPOSE
//   A records door that answers from rows the page gives it at mount, with no network: the door's read, list and write
//   (records-door.ts) over one memory. A page that is not the signed-in workspace page (a standalone example, a test)
//   mounts it with setRecordsDoor(seededRecordsDoor(rows)); every change stays in that memory.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rows are keyed by type and id, as the door keys them: a read or write of one id under another type is another record.
//   2. A write whose value is null erases the record, as the door does; an erased record is never listed.
//   3. A list answers every record of the type in the order they were given (no paging, no `order`, no `where`): a page
//      that needs those reads them from the Worker's door.

import type { RecordsDoor, StoredRecord } from './records-door';

const keyOf = (type: string, id: string) => `${type}\n${id}`;

/** The door over `rows` (each a record: its id, type and value), held in memory for the life of the page. `rows()` reads
 *  what it holds now, so a page or a check can see what a screen wrote. */
export function seededRecordsDoor(rows: readonly StoredRecord[]): RecordsDoor & { rows(): StoredRecord[] } {
  const held = new Map<string, StoredRecord>();
  for (const row of rows) if (row.type !== undefined) held.set(keyOf(row.type, row.id), row);
  return {
    rows: () => [...held.values()],
    read: async input => {
      const { id, type } = input as { id: string; type: string };
      const row = held.get(keyOf(type, id));
      return { id, type, value: row?.value ?? null };
    },
    list: async input => {
      const { type } = input as { type: string };
      const records = [...held.values()].filter(row => row.type === type && row.value !== null);
      return { records, next: null };
    },
    write: async body => {
      for (const record of body.records) {
        if (record.type === undefined) throw new Error('A seeded record needs its type.');
        const key = keyOf(record.type, record.id);
        if (record.value === null) held.delete(key);
        else held.set(key, { id: record.id, type: record.type, value: record.value });
      }
      return { changed: true, write_count: body.records.length };
    },
  };
}
