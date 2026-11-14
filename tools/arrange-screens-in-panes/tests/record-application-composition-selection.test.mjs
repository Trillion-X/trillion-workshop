import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));
const action = manifest.things.find((thing) => thing.payload?.id === 'action:screen-arrangement.record-application-composition-selection')?.payload;

test('the screen owner can record a generic admitted application selection', () => {
  assert.ok(action);
  assert.deepEqual(action.input_schema.required, ['selection_ref', 'selection']);
  assert.equal(action.input_schema.additionalProperties, false);
  const item = action.steps[0].config.items[0];
  assert.equal(item.address_mode, 'label_hash');
  assert.deepEqual(item.address, {$kind: 'binding', select: {from: 'input', path: 'selection_ref'}});
  assert.deepEqual(item.path, ['current-item', 'published-record', 'application-composition-selection']);
  assert.deepEqual(item.payload, {$kind: 'binding', select: {from: 'input', path: 'selection'}});
});

test('the selection recorder stays generic and does not name Trillion or a package-set record', () => {
  const encoded = JSON.stringify(action);
  assert.doesNotMatch(encoded, /trillion/i);
  assert.doesNotMatch(encoded, /package-set-record/);
});
