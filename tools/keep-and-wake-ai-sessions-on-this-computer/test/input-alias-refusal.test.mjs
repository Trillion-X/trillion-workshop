// The alias refusal before dispatch (src/input-alias-refusal.mjs): ported from the old tools-batch test "required inputs
// reject aliases before dispatch in single and batch calls, while exact Unicode identity passes". The old test ran the
// whole MCP path; this checks the pure rule on the same inputs, and a wiring test checks the owner calls it before dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aliasProblems } from '../src/input-alias-refusal.mjs';

const schema = { type: 'object', required: ['name_or_identity'], properties: { name_or_identity: { type: 'string' } } };
const nfd = 'cafe\u0301.txt';
const nfc = 'caf\u00e9.txt';
const REFUSAL = 'Invalid input: missing required field: name_or_identity.';

test('a single call that names the required field by an alias is refused with the old words', () => {
  assert.deepEqual(aliasProblems({ path: nfd }, schema), [REFUSAL]);
  assert.deepEqual(aliasProblems({ file: nfd }, schema), [REFUSAL]);
});

test('the exact field name passes, and an exact Unicode identity is not changed by the check', () => {
  assert.deepEqual(aliasProblems({ name_or_identity: nfd }, schema), []);
  assert.deepEqual(aliasProblems({ name_or_identity: nfc }, schema), []);
  assert.notEqual(nfd, nfc, 'the two spellings are different identities');
});

test('a batch is checked item by item: the aliased item is refused, the exact one passes', () => {
  const items = [{ input: { file: nfd } }, { input: { name_or_identity: nfd } }];
  assert.deepEqual(items.map(item => aliasProblems(item.input, schema)), [[REFUSAL], []]);
});

test('an input with no alias key is left to the schema check, and a missing field with no alias is not an alias refusal', () => {
  assert.deepEqual(aliasProblems({}, schema), [], 'no extra key: the waiting-for-input path decides, not the alias check');
  assert.deepEqual(aliasProblems({ name_or_identity: nfd, note: 'extra' }, { ...schema, properties: { ...schema.properties, note: { type: 'string' } } }), []);
});

test('several missing required fields are named together, and a schema that refuses extra keys is left to schemaProblems', () => {
  const two = { type: 'object', required: ['a', 'b'], properties: { a: {}, b: {} } };
  assert.deepEqual(aliasProblems({ c: 1 }, two), ['Invalid input: missing required fields: a, b.']);
  assert.deepEqual(aliasProblems({ c: 1 }, { ...two, additionalProperties: false }), []);
});

test('non-object inputs and schemas give no alias words', () => {
  assert.deepEqual(aliasProblems(null, schema), []);
  assert.deepEqual(aliasProblems(['x'], schema), []);
  assert.deepEqual(aliasProblems({ path: nfd }, null), []);
});

test('the owner calls the alias check before each dispatch path', () => {
  const source = readFileSync(new URL('../src/workshop.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ aliasProblems \} from '\.\/input-alias-refusal\.mjs';/);
  const calls = source.match(/aliasProblems\(/g) ?? [];
  assert.equal(calls.length, 3, 'three calls: the run path, the read-once path and the relay path');
});
