// The records-door client (tools/records-door) against the fake door, holding records in memory with exactly the rights
// of the relate row, which is everything the read rows have and more. Every test record is made up.
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

export const rightsOf = id => rowOf(rows, id).invoke.records.rights;
const everyRight = () => {
  const merged = new Map();
  for (const id of ['tool:relate-records', 'tool:read-the-graph-around-a-record', 'tool:find-how-records-connect']) {
    for (const right of rightsOf(id)) merged.set(right.kind, [...new Set([...(merged.get(right.kind) ?? []), ...right.operations])]);
  }
  return [...merged].map(([kind, operations]) => ({ kind, operations }));
};

/** A fresh door holding `records`, closed when the test ends: { door, fake }. */
export async function freshDoor(t, { records = [], rights = everyRight() } = {}) {
  const fake = await startFakeDoor({ rights, records });
  t.after(() => fake.close());
  return { door: openRecordsDoor({ descriptor: fake.descriptor }), fake };
}
