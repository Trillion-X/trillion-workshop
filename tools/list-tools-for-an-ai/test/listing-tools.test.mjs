// The four rows run as the container runs them (tools/records-door's run-an-export.mjs), over synthetic tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import budget from '../read-data/tool-listing-budget.json' with { type: 'json' };

const tool = n => ({ name: `tool_${n}`, description: `Does job ${n}. More words about it.`.padEnd(300, 'x'),
  inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'the first thing' } } } });
const tools = Array.from({ length: 5 }, (_, n) => tool(n));

test('fit a tool list: unchanged without a budget, the least detail when nothing fits, named tools in full', async () => {
  const row = rowOf(rows, 'tool:fit-a-tool-list-in-a-budget');
  const whole = await runRow(row, { tools });
  assert.equal(whole.status, 0);
  assert.deepEqual(whole.result, { tools, listing: {} });
  const big = await runRow(row, { tools, budget_chars: 100000 });
  assert.equal(big.result.listing.level, budget.levels[0].id);
  assert.equal(big.result.listing.said, undefined);
  const small = await runRow(row, { tools, budget_chars: 10, names: ['tool_2', 'nope'] });
  assert.equal(small.result.listing.level, 'names');
  assert.equal(small.result.listing.fits, false);
  assert.equal(small.result.tools.length, 5);
  assert.deepEqual(small.result.tools[3].inputSchema, { type: 'object' });
  assert.deepEqual(small.result.tools[2], tools[2]);
  assert.deepEqual(small.result.listing.unknown, ['nope']);
  assert.match(small.result.listing.unknown_said, /No tool by these names: nope/);
});

test('say a tool\'s hints: the sentences are added once; a tool with no hints is unchanged', async () => {
  const row = rowOf(rows, 'tool:say-a-tools-hints-in-its-description');
  const reading = await runRow(row, { tool: { name: 'r', description: 'Lists things.', annotations: { readOnlyHint: true } } });
  assert.match(reading.result.description, /^Lists things\. Reads only/);
  const already = { name: 'd', description: 'Deletes it. Confirm with the person first.', annotations: { destructiveHint: true } };
  assert.deepEqual((await runRow(row, { tool: already })).result, already);
  const bare = { name: 'b', description: 'Does a thing.' };
  assert.deepEqual((await runRow(row, { tool: bare })).result, bare);
});

test('tell if a tool changes anything: from read_only, invoke.action or the id', async () => {
  const row = rowOf(rows, 'tool:tell-if-a-tool-changes-anything');
  const classOf = async tool => (await runRow(row, { tool })).result.write_class;
  assert.equal(await classOf({ id: 'tool:find-sample' }), 'read');
  assert.equal(await classOf({ id: 'tool:send-sample' }), 'write');
  assert.equal(await classOf({ id: 'tool:odd', read_only: true }), 'read');
  assert.equal(await classOf({ id: 'tool:x', invoke: { action: 'show-things' } }), 'read');
  assert.equal(await classOf({}), 'write');
});

test('pick the release a host runs: newest that runs, else null with the version needed; host_version is required', async () => {
  const row = rowOf(rows, 'tool:pick-the-release-a-host-runs');
  const published = { id: 't', label: 'second', minimum_host_version: '2026.10.1', earlier_releases: [{ id: 't', label: 'first', minimum_host_version: '2026.9' }] };
  assert.equal((await runRow(row, { row: published, host_version: '2026.10.1' })).result.release.label, 'second');
  const behind = await runRow(row, { row: published, host_version: '2026.9.28' });
  assert.deepEqual(behind.result.release, { id: 't', label: 'first', minimum_host_version: '2026.9' });
  assert.deepEqual((await runRow(row, { row: published, host_version: '2026.8' })).result, { release: null, oldest_needed: '2026.9' });
  const missing = await runRow(row, { row: published });
  assert.equal(missing.status, 1);
  assert.match(missing.error, /Give host_version/);
});
