// Tests for the lesson page's input (read-data/lesson-input.mjs). The lessons are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lessonInputOf } from '../read-data/lesson-input.mjs';

test('a row gives the page its text fields and its resources', () => {
  const resources = [{ id: 'r1', label: 'Dough guide', url: 'https://example.com/dough.pdf', media_type: 'application/pdf' }];
  const row = { title: 'Knead', summary: 'Work the dough.', body: '# Knead\n\nPush and fold.', do_now: 'Knead for ten minutes.', primary_resource_id: 'r1', resources };
  assert.deepEqual(lessonInputOf('record:lesson:knead', row), { lesson_id: 'record:lesson:knead', ...row });
});

test('a field the row does not hold is left out, so the page shows its empty state', () => {
  assert.deepEqual(lessonInputOf('record:lesson:proof', { title: 'Proof', body: '', do_now: 4, resources: 'none' }), { lesson_id: 'record:lesson:proof', title: 'Proof' });
});

test('a row not read yet gives only the lesson id', () => {
  assert.deepEqual(lessonInputOf('record:lesson:bake', null), { lesson_id: 'record:lesson:bake' });
});
