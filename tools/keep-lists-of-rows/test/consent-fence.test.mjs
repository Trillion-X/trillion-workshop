// The Lists read against the consent fence: a fenced table this use is not allowed is refused; any other answer draws its rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fencedReadOf, NO_USE_BINDING } from '../read-data/consent-fence.mjs';

test('a fenced table this use is not allowed for is refused, with no rows drawn', () => {
  assert.deepEqual(fencedReadOf({ fenced: true, allowed: false, rows: '[{"id":1}]' }), { refused: true, rows: [{ id: 1 }] });
});

test('a fenced table this use is allowed for draws its rows, even when there are none', () => {
  assert.deepEqual(fencedReadOf({ fenced: true, allowed: true, rows: '[]' }), { refused: false, rows: [] });
});

test('an unfenced table draws its rows as they are', () => {
  assert.deepEqual(fencedReadOf({ fenced: false, allowed: null, rows: [{ id: 2 }] }), { refused: false, rows: [{ id: 2 }] });
});

test('a database with no use_binding schema is recognised by its error', () => {
  assert.match('ERROR: schema "use_binding" does not exist', NO_USE_BINDING);
  assert.doesNotMatch('ERROR: relation "x" does not exist', NO_USE_BINDING);
});
