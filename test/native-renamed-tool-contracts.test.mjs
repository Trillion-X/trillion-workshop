import test from 'node:test';
import assert from 'node:assert/strict';
import { rows, json, tools, root } from '../test-helpers/tool-rows.mjs';
import { join } from 'node:path';

const current = rows();
const one = id => {
  const found = current.filter(row => row.payload.id === id);
  assert.equal(found.length, 1, `${id} has exactly one active capability owner`);
  return found[0];
};
const former = (file, id) => json(join(tools, file)).records.find(row => row.payload.id === id).payload;
const listening = 'listen-for-a-while/records/workshop-listening-tool-records.json';
const harness = 'keep-and-wake-ai-sessions-on-this-computer/from-an-older-version/records/workshop-harness-setup-tool-records.json';

for (const [id, folder, file] of [
  ['tool:listen', 'listen-for-a-while', listening],
  ['tool:enroll-someone', 'know-who-is-in-this', listening],
]) test(`${id} retains its full native request and response contract`, () => {
  const actual = one(id), original = structuredClone(former(file, id));
  // The publication owner supplies generic human wording; the native request fields and validation stay exact.
  if (id === 'tool:enroll-someone') original.input_schema.properties.file.description = "A recording or picture in the person's files, by name or identity";
  assert.equal(actual.folder, folder);
  assert.equal(actual.payload.status, 'active');
  for (const field of ['input_schema', 'output_schema', 'invoke', 'placements'])
    assert.deepEqual(actual.payload[field], original[field], `${id}: ${field}`);
  assert.equal(actual.payload.invoke.kind, 'computer-tool', 'the installed host retains its existing native implementation');
  assert.equal(actual.payload.invoke.tool_id, id);
});

test('native harness setup retains exact-computer admission and reviews every current definition', () => {
  const { folder, payload } = one('tool:manage-harness');
  const original = structuredClone(former(harness, payload.id));
  const settings = json(join(tools, folder, 'harness/setup.json'));
  const review = original.input_schema.properties.reviewed_definition_hashes;
  review.minItems = review.maxItems = settings.hooks.length;
  review.description = 'All current configuration.evidence.hooks definition_hash values from the reviewed inspect report; required only when trust_hooks is true.';
  assert.ok(settings.hooks.length > 0);
  for (const field of ['input_schema', 'output_schema', 'invoke', 'placements'])
    assert.deepEqual(payload[field], original[field], field);
  assert.deepEqual(payload.input_schema.required, ['computer_id', 'harness', 'action']);
  assert.deepEqual(payload.input_schema.properties.action.enum, ['inspect', 'apply', 'remove']);
  assert.equal(payload.input_schema.additionalProperties, false);
  assert.equal(payload.input_schema.properties.reviewed_definition_hashes.uniqueItems, true);
  assert.equal(payload.input_schema.properties.reviewed_definition_hashes.items.pattern, '^[a-f0-9]{64}$');
});

test('connection carrying retains the installed program lifecycle and accepts no process controls', () => {
  const { folder, payload } = one('tool:carry-connections');
  assert.equal(folder, 'run-the-connections-and-automations-my-computers-carry-keeping');
  assert.deepEqual(payload.input_schema, { type: 'object', additionalProperties: false, properties: {} });
  assert.deepEqual(payload.output_schema, { type: 'object' });
  assert.deepEqual(payload.invoke, { kind: 'computer-tool', tool_id: payload.id, program: 'connections', needs_build: 'mac-program-host' });
  assert.match(payload.description, /Installing this tool turns carrying on.*removing it stops it/);
  assert.deepEqual(payload.placements, ['placement:your-computer']);
});


test('native descriptor folders retain exactly one registered receiving capability owner', () => {
  const declared = json(join(root, 'capabilities.json')).capabilities;
  for (const id of ['tool:listen', 'tool:enroll-someone', 'tool:manage-harness', 'tool:carry-connections']) {
    const { folder } = one(id);
    const prefix = `tools/${folder}/`;
    const owners = declared.filter(row => row.owner?.includes(prefix));
    assert.equal(owners.length, 1, `${id}: ${prefix} has one receiving capability owner`);
    assert.ok(owners[0].entry.startsWith(prefix), `${id}: the declared entry is in its receiving owner`);
    assert.ok(owners[0].capability && owners[0].evidence, `${id}: owner registration names its job and evidence`);
  }
});
