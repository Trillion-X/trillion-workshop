// The standalone example page (web/examples/standalone-workspace): its made-up sidebar rows name the screens its entry
// mounts, and every row is the placeable-surface record shape the sidebar and the arrangement decode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOOR_ROWS, LIST, PACKAGE, SEEDS, SURFACES } from '../web/examples/standalone-workspace/seeds.ts';

const ENTRY_TEXT = readFileSync(new URL('../web/examples/standalone-workspace/entry.ts', import.meta.url), 'utf8');

test('the seeded sidebar holds one placeable surface per screen, in order', () => {
  assert.deepEqual(SURFACES.map(row => row.payload.label), ['Courses', 'Posts', 'Chat', 'Account']);
  assert.deepEqual(SURFACES.map(row => row.payload.order), [1, 2, 3, 4]);
  assert.equal(SEEDS[LIST], SURFACES);
});

test('every surface row is a placeable surface that opens a screen of this page', () => {
  for (const row of SURFACES) {
    assert.equal(row.payload.kind, 'placeable-surface');
    assert.equal(row.payload.package_entry.package_name, PACKAGE);
    assert.deepEqual(row.payload.placement_labels, [PACKAGE]);
    assert.ok(ENTRY_TEXT.includes(`'${row.payload.package_entry.entry_name}':`) || ENTRY_TEXT.includes(`${row.payload.package_entry.entry_name}:`),
      `entry.ts mounts no screen named ${row.payload.package_entry.entry_name}`);
  }
  assert.equal(new Set(SURFACES.map(row => row.payload.package_entry.entry_name)).size, SURFACES.length);
});

test('the course rows name lessons that exist, and the course list opens its lesson by the lessons package entry', () => {
  const course = DOOR_ROWS.find(row => row.type === 'record:course');
  const lessons = DOOR_ROWS.filter(row => row.type === 'record:lesson').map(row => row.id);
  assert.deepEqual(course.value.lesson_ids.filter(id => !lessons.includes(id)), []);
  assert.ok(ENTRY_TEXT.includes("'lessons-and-learning-paths/course-lesson-screen-mount'"));
});
