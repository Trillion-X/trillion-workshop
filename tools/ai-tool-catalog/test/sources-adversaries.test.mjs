// Independent lifecycle controls over isolated owners. No account, credential or network is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountToolSources, accountToolSourcesFromDoor } from '../../describe-the-workshop/do-work/sources.mjs';

const config = () => ({ kinds: { mcp: { label: 'A tool server', becomes: 'tool', source: { kind: 'tool-row-source', list: { mcp: {} } } } }, sources: [] });
const source = () => ({ id: 'fixture', kind: 'mcp', url: 'https://fixture.example/mcp' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function owner() {
  const records = new Map(), writes = [];
  let revision = 0;
  const door = {
    async readRecord(type, id) {
      const record = records.get(id);
      return record?.type === type ? structuredClone(record) : null;
    },
    async *list({ type, prefix }) {
      for (const [id, record] of records) if (record.type === type && id.startsWith(prefix)) yield { id, ...structuredClone(record) };
    },
    async write(changes, options) {
      for (const change of changes) {
        const record = records.get(change.id);
        const before = record ? { type: record.type, value: record.value,
          ...(Object.hasOwn(change.expected ?? {}, 'identity') ? { identity: record.identity } : {}) } : null;
        if (!same(before, change.expected)) throw Object.assign(new Error('CAS refused'), { code: 'original_command_conflict' });
      }
      for (const change of changes) records.set(change.id, { type: change.type, value: structuredClone(change.value), identity: `revision-${++revision}` });
      writes.push(structuredClone({ changes, options }));
      return { committed: true };
    },
  };
  const sourceConfig = { config: async () => config(), reads: async () => [] };
  return { records, writes, door, sourceConfig };
}

test('fresh adapter retry preserves the exact source write and rejects different command under its key', async () => {
  const state = owner();
  const request = { add: source(), request_key: 'isolated-add' };
  const first = await accountToolSourcesFromDoor(request, { ...state, now: () => new Date('2026-11-01T00:00:00Z') });
  const repeated = await accountToolSourcesFromDoor(request, { ...state, now: () => new Date('2026-11-08T00:00:00Z') });
  assert.deepEqual(repeated, first);
  assert.equal(state.writes.length, 1);
  assert.equal(state.records.get('tool-source:fixture').value.added_at, '2026-11-01T00:00:00.000Z');
  assert.equal(state.writes[0].changes.length, 2, 'source and semantic receipt share the same atomic write');
  await assert.rejects(accountToolSourcesFromDoor({ ...request, add: { ...source(), name: 'changed' } }, state), { code: 'source_request_conflict' });
  assert.equal(state.writes.length, 1);
});

test('source removal preserves original identity and retry creates no extra tombstone', async () => {
  const state = owner();
  await accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-add' }, state);
  const original = structuredClone(state.records.get('tool-source:fixture').value);
  const request = { remove: 'fixture', request_key: 'isolated-remove' };
  assert.deepEqual((await accountToolSourcesFromDoor(request, state)).yours, []);
  assert.deepEqual((await accountToolSourcesFromDoor(request, state)).yours, []);
  const removed = state.records.get('tool-source:fixture').value;
  assert.equal(removed.id, original.id);
  assert.equal(removed.added_at, original.added_at);
  assert.equal(removed.status, 'deleted');
  assert.equal(state.writes.length, 2);
});

test('native root revision fences a source changed and restored during its tool read', async () => {
  const state = owner();
  await accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-add' }, state);
  state.sourceConfig.reads = async () => {
    state.records.get('tool-source:fixture').identity = 'revision-aba';
    return [];
  };
  await assert.rejects(accountToolSourcesFromDoor({}, state), { code: 'source_definitions_changed' });
  assert.equal(state.writes.length, 1);
});

test('source mutation CAS rejects an equal-payload ABA before the physical write', async () => {
  const state = owner();
  await accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-add' }, state);
  const write = state.door.write;
  state.door.write = async (...args) => {
    state.records.get('tool-source:fixture').identity = 'revision-raced';
    return write(...args);
  };
  await assert.rejects(accountToolSourcesFromDoor({ edit: { id: 'fixture', name: 'new name' }, request_key: 'isolated-edit' }, state), { code: 'original_command_conflict' });
  assert.equal(state.records.get('tool-source:fixture').value.name, undefined);
  assert.equal(state.writes.length, 1);
});

test('acknowledged receipt recovers a lost write reply without another write', async () => {
  const state = owner();
  const write = state.door.write;
  state.door.write = async (...args) => {
    await write(...args);
    throw Object.assign(new Error('Synthetic transport reply lost'), { code: 'call_unknown', outcome: 'unknown' });
  };
  const answer = await accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-lost-reply' }, state);
  assert.equal(answer.yours[0].id, 'fixture');
  assert.equal(state.writes.length, 1);
});

test('unresolved write keeps the original unknown result and makes no retry', async () => {
  const state = owner();
  const unknown = Object.assign(new Error('Synthetic unknown write'), { code: 'call_unknown', outcome: 'unknown' });
  let attempts = 0;
  state.door.write = async () => { attempts += 1; throw unknown; };
  await assert.rejects(accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-unknown' }, state), error => error === unknown);
  assert.equal(attempts, 1);
  assert.equal(state.records.size, 0);
});

test('source metadata cannot substitute for credential or owner admission', async () => {
  const state = owner();
  for (const add of [
    { ...source(), headers: { authorization: 'synthetic-not-a-credential' } },
    { ...source(), url: 'https://user:synthetic@example.com/mcp' },
    { ...source(), connection: { connection_id: 'fixture', field_id: 'key', connection: { trusted: true } } },
    { ...source(), trusted: true },
  ]) await assert.rejects(accountToolSourcesFromDoor({ add, request_key: 'isolated-refusal' }, state));
  assert.equal(state.writes.length, 0);
  await assert.rejects(accountToolSources({}, {}), { code: 'source_owner_unavailable' });
  await assert.rejects(accountToolSourcesFromDoor({ add: source(), request_key: 'isolated-refusal' }, { door: state.door }), { code: 'source_owner_unavailable' });
});
