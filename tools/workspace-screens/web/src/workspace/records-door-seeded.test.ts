// The seeded records door answers the door's read, list and write from its memory: a record is keyed by type and id,
// a write of null erases it, and a list gives only the type asked for.
import assert from 'node:assert/strict';
import test from 'node:test';
import { seededRecordsDoor } from './records-door-seeded.ts';

test('a seeded door reads, lists and writes by type and id, and erases on a null write', async () => {
  const door = seededRecordsDoor([
    { id: 'lesson-1', type: 'record:lesson', value: { title: 'Welcome' } },
    { id: 'course-1', type: 'record:course', value: { title: 'Starting out' } },
  ]);
  assert.deepEqual(await door.read({ id: 'lesson-1', type: 'record:lesson' }), { id: 'lesson-1', type: 'record:lesson', value: { title: 'Welcome' } });
  assert.deepEqual(await door.read({ id: 'lesson-1', type: 'record:course' }), { id: 'lesson-1', type: 'record:course', value: null });
  assert.deepEqual((await door.list({ type: 'record:lesson' }) as { records: unknown[] }).records.map((row: any) => row.id), ['lesson-1']);

  await door.write({ records: [{ id: 'lesson-done:1', type: 'record:lesson-done', value: { course_id: 'course-1' } }] }, false);
  assert.equal((await door.read({ id: 'lesson-done:1', type: 'record:lesson-done' }) as { value: unknown }).value !== null, true);

  await door.write({ records: [{ id: 'lesson-done:1', type: 'record:lesson-done', value: null }] }, true);
  assert.equal((await door.read({ id: 'lesson-done:1', type: 'record:lesson-done' }) as { value: unknown }).value, null);
  assert.equal(door.rows().some(row => row.id === 'lesson-done:1'), false);
});
