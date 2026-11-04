// tool:describe-a-tool: the cases of the trillion-rust engine's describe resolver (src/workshop_describe.rs tests, moved
// here with the resolver) and the sample rule cases of trillion test/workshop-sample-rules.test.mjs, over made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeATool } from '../do-work/describe.mjs';
import { sampleRuleOf, unsafeSample } from '../read-data/workshop-sample-rules.mjs';

const noDoor = { door: { read: async () => null } };
const describe = (input, context = noDoor) => describeATool(input, context);

test('a shared screen is described without samples and with no next call', async () => {
  const shared = [{ kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts', label: 'Foo' }, label: 'Foo' }];
  const value = await describe({ tool_id: 'tool:foo', shared });
  assert.equal(value.made_by, 'shared');
  assert.equal(value.descriptor.screen.kind, 'parts');
  assert.equal(value.next_call, null);
  assert.equal(value.samples, undefined);
});

test('a saved screen replaces the shared row, takes listed_on from saved_at and is answered save_tool', async () => {
  const shared = [{ kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, label: 'Shared' }];
  const saved = { kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, label: 'Saved', saved_at: '2026-10-01' };
  const value = await describe({ tool_id: 'tool:foo', shared, saved });
  assert.equal(value.made_by, 'this account');
  assert.equal(value.descriptor.label, 'Saved');
  assert.equal(value.next_call.tool, 'save_tool');
  assert.equal(value.descriptor.listed_on, '2026-10-01');
});

test('the saved row is read through the records door by its type and id', async () => {
  const asked = [];
  const door = { read: async (type, id) => { asked.push([type, id]); return { kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, label: 'Saved' }; } };
  const value = await describe({ tool_id: 'tool:foo', shared: [] }, { door });
  assert.deepEqual(asked, [['tool', 'tool:tool:foo']]);
  assert.equal(value.made_by, 'this account');
});

test('a deleted saved row leaves the shared row described', async () => {
  const shared = [{ kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, label: 'Shared' }];
  const saved = { kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, status: 'deleted' };
  const value = await describe({ tool_id: 'tool:foo', shared, saved });
  assert.equal(value.made_by, 'shared');
});

test('an inactive saved row still replaces the shared row, so there is nothing to describe', async () => {
  const shared = [{ kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, label: 'Shared' }];
  const saved = { kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' }, status: 'paused' };
  await assert.rejects(describe({ tool_id: 'tool:foo', shared, saved }), /There is no tool tool:foo/);
});

test('a runnable shared tool is answered run_tool; a placement whose executor has no rule gives no sample rule', async () => {
  const shared = [
    { kind: 'tool-placement', id: 'hosted', label: 'Hosted', executor: 'service', reachable_from: ['hosted'] },
    { kind: 'ai-tool-descriptor', id: 'tool:foo', invoke: { kind: 'host' }, placements: ['hosted'] },
  ];
  const value = await describe({ tool_id: 'tool:foo', shared });
  assert.equal(value.next_call.tool, 'run_tool');
  assert.equal(value.next_call.arguments.tool_id, 'tool:foo');
  assert.equal(value.sample_rule, undefined);
});

test('a placement whose executor has a rule gives that rule, and a former placement id is read as its current one', async () => {
  const ruled = [
    { kind: 'tool-placement', id: 'hosted', label: 'Hosted', executor: 'agent', reachable_from: ['hosted'] },
    { kind: 'ai-tool-descriptor', id: 'tool:foo', invoke: { kind: 'host' }, placements: ['hosted'] },
  ];
  const rule = (await describe({ tool_id: 'tool:foo', shared: ruled })).sample_rule;
  assert.deepEqual(rule, { safe: ['read-only', 'dry-run'], unconnected: 'owed', owed_until: 'first-connected-computer', readback: 'describe-only' });

  // The original chooser maps a former placement id to its current id.
  const renamed = [
    { kind: 'tool-placement', id: 'placement:your-mac', label: 'Former', executor: 'service', reachable_from: ['hosted'] },
    { kind: 'tool-placement', id: 'placement:your-computer', label: 'Current', executor: 'agent', reachable_from: ['hosted'] },
    { kind: 'ai-tool-descriptor', id: 'tool:foo', invoke: { kind: 'host' }, placements: ['placement:your-mac'] },
  ];
  assert.equal((await describe({ tool_id: 'tool:foo', shared: renamed })).sample_rule.readback, 'describe-only');
});

test('a saved runnable tool answers its declared samples', async () => {
  const check = { kind: 'sample-run', safety: 'read-only', input: {} };
  const saved = { kind: 'ai-tool-descriptor', id: 'tool:foo', invoke: { kind: 'host' }, verify: [check, { kind: 'other' }] };
  const value = await describe({ tool_id: 'tool:foo', shared: [], saved });
  assert.deepEqual(value.samples, [{ ...check, state: null }]);
  assert.equal(value.next_call.tool, 'save_tool');
});

test('refusals say what to give', async () => {
  await assert.rejects(describe({}), /tool_id is the id/);
  await assert.rejects(describe({ tool_id: 'tool:\u0001' }), /control character/);
  await assert.rejects(describe({ tool_id: 'tool:foo', shared: {} }), /shared is the list/);
  await assert.rejects(describe({ tool_id: 'tool:foo', shared: [], saved: { id: 'tool:bar' } }), /not that tool's row/);
  const twice = [{ kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' } }, { kind: 'ai-tool-descriptor', id: 'tool:foo', screen: { kind: 'parts' } }];
  await assert.rejects(describe({ tool_id: 'tool:foo', shared: twice }), /more than once/);
  await assert.rejects(describe({ tool_id: 'tool:missing', shared: [] }), /There is no tool tool:missing/);
});

// trillion test/workshop-sample-rules.test.mjs, its first case, unchanged.
const descriptor = verify => ({ id: 'tool:fixture-screen', label: 'Fixture screen', job: 'Read or operate the fixture screen',
  input_schema: { type: 'object', properties: { app: { type: 'string' }, dry_run: { type: 'boolean' } } }, output_schema: { type: 'object' },
  invoke: { kind: 'computer-tool', tool_id: 'tool:fixture-screen' }, placements: ['placement:fixture-computer'], licence_class: 'licence:fixture',
  needs: { network_egress: false }, verify });
const safe = { kind: 'sample-run', safety: 'read-only', input: { app: 'Finder' }, output_selector: '$.app', contains: 'Finder', evidence: ['test/drive-the-screen.test.mjs'] };

test('the rule is DATA by executor: a placement whose executor has no row keeps its samples as before', () => {
  const rule = sampleRuleOf({ executor: 'agent' });
  assert.deepEqual(rule.safe, ['read-only', 'dry-run']);
  assert.equal(sampleRuleOf({ executor: 'container' }), null);
  const tool = descriptor([]);
  assert.equal(unsafeSample(rule, tool, safe), null);
  assert.match(unsafeSample(rule, tool, { ...safe, safety: undefined }), /must say its safety/);
  assert.match(unsafeSample(rule, tool, { ...safe, safety: 'dry-run' }), /dry_run to true/);
  assert.equal(unsafeSample(rule, tool, { ...safe, safety: 'dry-run', input: { dry_run: true } }), null);
  assert.match(unsafeSample(rule, { ...tool, input_schema: { type: 'object', properties: {} } }, { ...safe, safety: 'dry-run', input: { dry_run: true } }), /dry_run to true/, 'a tool with no dry-run input cannot rehearse');
});
