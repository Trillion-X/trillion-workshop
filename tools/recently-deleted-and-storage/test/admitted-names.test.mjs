// Real production adapter/client path against a synthetic wire contract. This
// checks transport composition; it is NOT proof that Native mounted the route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedNamesFromDoor } from '../do-work/admitted-names.mjs';
import { runTask } from '../do-work/account-archive.mjs';
import { recordsDoorFromCall } from '../../records-door/read-data/records-door.mjs';

const contract = 'native-conditioned-names/v1';
const generation = 'a'.repeat(64), destination = 'b'.repeat(64), moved = 'c'.repeat(64), vacated = 'd'.repeat(64);
const identity = `1f:${'e'.repeat(64)}`;
const row = { name: '/note', identity, generation, destination_generation: destination };
const observation = input => ({ contract, status: 'present', observation: { tree: input.tree, name: input.name, folder: false, members: [row], folders: [], next_after: null } });
const task = key => ({ task_id: key, request_key: key, started_at: '2026-11-01T00:00:00Z', context: {
  account_id: 'synthetic-holder', admission: 'account', actor: { kind: 'account', id: 'synthetic-holder' },
} });

test('old server, loading, rights/source refusals and malformed protocol never create archive metadata', async () => {
  for (const reply of [undefined, {}, { contract, status: 'loading' }, { contract, status: 'absent', tree: 'live', name: '/other' },
    { ...observation({ tree: 'live', name: '/note' }), observation: { tree: 'live', name: '/note', folder: false, members: [{ ...row, identity: null }], folders: [], next_after: null } },
    Object.assign(new Error('rights revoked'), { code: 'current_workspace_rights_refused', outcome: 'not_started' })]) {
    let writes = 0;
    const door = { readRecord: async () => null, write: async () => { writes += 1; }, files: async () => { if (reply instanceof Error) throw reply; return reply; } };
    await assert.rejects(runTask({ input: { action: 'archive', name: '/note' }, task: task('handshake') }, { door }));
    assert.equal(writes, 0);
  }
});

test('only source/right-checked typed absent becomes empty and attests support', async () => {
  const adapter = admittedNamesFromDoor({ files: async (_method, input) => ({ contract, status: 'absent', tree: input.tree, name: input.name }) });
  assert.equal(adapter.protocol, null);
  await adapter.ready({ tree: 'live', name: '/note' });
  assert.equal(adapter.protocol, 'fenced-names/1');
  assert.deepEqual((await adapter.observe({ tree: 'live', name: '/note', after: null, limit: 100 })).members, []);
});

test('production runTask creates the actual adapter and persists exact Native original before effect; recovery reads only original', async () => {
  const records = new Map(), sent = [], receipts = new Map();
  let serial = 0, live = true, loseAnswer = true, effects = 0;
  const call = async (method, input, key, address) => {
    sent.push({ method, input: structuredClone(input), key, address });
    if (method === 'records:read') return { type: input.type, ...(records.get(input.id) ?? { value: null }) };
    if (method === 'records:write') {
      for (const record of input.records) {
        const prior = records.get(record.id);
        assert.equal(record.expected === null ? prior === undefined : prior?.identity === record.expected.identity, true, 'actual current root fence');
        records.set(record.id, { value: structuredClone(record.value), identity: `root:${++serial}` });
      }
      return { changed: input.records.length };
    }
    assert.equal(address, '@synthetic-namespace');
    if (method === 'name_command_observe') {
      if (input.tree === 'live' && !live) return { contract, status: 'absent', tree: input.tree, name: input.name };
      const result = observation(input);
      if (input.tree === 'set_aside') result.observation.members = [{ ...row, generation: moved, destination_generation: vacated }];
      return result;
    }
    if (method === 'name_command_set_aside') {
      const frozen = [...records.values()].flatMap(record => record.value.members ?? []).find(member => member.command?.original.request_key === key);
      assert.equal(frozen.command.phase, 'attempted');
      assert.deepEqual(frozen.command.original, { request_key: key, operation: method, input });
      effects += 1; live = false;
      const result = { contract, status: 'committed', result: { name: '/note', generation: moved, destination_generation: vacated } };
      receipts.set(key, { original: { request_key: key, operation: method, input: structuredClone(input) }, result });
      if (loseAnswer) { loseAnswer = false; throw new TypeError('wire lost AFTER committed effect'); }
      return result;
    }
    if (method === 'name_command_result') {
      const kept = receipts.get(input.request_key);
      assert.deepEqual(input, kept.original);
      assert.notEqual(key, input.request_key, 'receipt delivery differs from original command key');
      return kept.result;
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const door = recordsDoorFromCall(call, { resource: '@synthetic-records', filesResource: '@synthetic-namespace' });
  const context = { door, get parentActions() { assert.fail('unused lazy parent actions must stay unopened'); } };
  let answer = await runTask({ input: { action: 'archive', name: '/note' }, task: task('real-adapter') }, context);
  assert.equal(answer.item.status, 'unknown'); assert.equal(effects, 1);
  answer = await runTask({ input: { action: 'continue', id: answer.item.id }, task: task('recover-delivery') }, context);
  assert.equal(answer.item.status, 'held'); assert.equal(effects, 1);
  assert.equal(sent.filter(call => call.method === 'name_command_set_aside').length, 1);
  assert.equal(sent.filter(call => call.method === 'name_command_result').length, 1);
});

test('missing or erased Native receipt stays unknown and explicit not-started is the only no-effect result', async () => {
  for (const outcome of ['unknown', 'not_started']) {
    const calls = [];
    const adapter = admittedNamesFromDoor({ files: async (method, input, options) => {
      calls.push({ method, input, options });
      if (method === 'name_command_observe') return observation(input);
      throw Object.assign(new Error('Native refusal'), { code: 'synthetic_refusal', outcome });
    } });
    await adapter.ready({ tree: 'live', name: '/note' });
    const original = { request_key: 'original-key', operation: 'name_command_set_aside', input: { name: '/note', expected_generation: generation, expected_destination_generation: destination } };
    if (outcome === 'not_started') assert.equal((await adapter.operation(original)).status, 'not_started');
    else await assert.rejects(adapter.operation(original), { outcome: 'unknown' });
    await assert.rejects(adapter.result(original), { outcome });
    assert.deepEqual(calls.at(-1).input, original);
    assert.equal(calls.at(-1).method, 'name_command_result');
  }
});

test('malformed committed replies never become a known effect or trigger a replacement command', async () => {
  const original = { request_key: 'original-key', operation: 'name_command_set_aside', input: { name: '/note', expected_generation: generation, expected_destination_generation: destination } };
  for (const result of [
    { name: '/note', folder: 0, generation: moved, destination_generation: vacated },
    { name: '/note', generation: moved, destination_generation: vacated, forgotten: true },
    { name: '/other', generation: moved, destination_generation: vacated },
    { name: '/note', generation: moved },
  ]) {
    const calls = [];
    const adapter = admittedNamesFromDoor({ files: async (method, input) => {
      calls.push(method);
      return method === 'name_command_observe' ? observation(input) : { contract, status: 'committed', result };
    } });
    await adapter.ready({ tree: 'live', name: '/note' });
    await assert.rejects(adapter.operation(original), { code: 'native_original_result_invalid' });
    await assert.rejects(adapter.result(original), { code: 'native_original_result_invalid' });
    assert.deepEqual(calls, ['name_command_observe', 'name_command_set_aside', 'name_command_result']);
  }
});
