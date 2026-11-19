// The shared caller of the task rows (run-a-task-move.mjs) over a fake account: records:list pages through every task,
// tools:run runs the real row function over the records handed in, and records:write applies the keep writes only where
// each record still holds the value it was read at. Made-up people, AIs and tasks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { readFor, runTaskMove } from '../run-a-task-move.mjs';
import * as moves from '../task-moves.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
const NOW = Date.parse('2026-11-19T08:00:00.000Z') + 60000;
const now = () => new Date(NOW);
const CHANGED = 'original_command_conflict';
const task = (id, status, extra = {}) => ({ id, type: 'calendar-task', value: { title: id, status, assignees: [], sent_by: 'ai:east', priority: 'medium', sent_at: '2026-11-19T07:00:00.000Z', ...extra } });
const PEOPLE = [
  { id: 'ai:north', type: 'ai', value: { label: 'north', can: ['code'], order: 1 } },
  { id: 'ai:east', type: 'ai', value: { label: 'east', can: ['code'], order: 2 } },
];

// The fake account. `pageSize` bounds each records:list page; `beforeWrite` runs once the row has answered, before the write.
function fakeAccount(records, { pageSize = 2, beforeWrite = null } = {}) {
  const kept = new Map(records.map(record => [record.id, { ...record }]));
  const seen = { runs: [], writes: [] };
  const same = (a, b) => makeHashCodeHexFromJson(a ?? null) === makeHashCodeHexFromJson(b ?? null);
  const resource = async (address, method, input, key) => {
    if (address === '@own-records' && method === 'records:list') {
      const rows = [...kept.values()].filter(record => record.type === input.type && Object.entries(input.where ?? {}).every(([field, value]) => record.value?.[field] === value));
      const start = input.after ? Number(input.after) : 0;
      const page = rows.slice(start, start + Math.min(input.limit, pageSize));
      return { records: page.map(record => ({ id: record.id, value: record.value })), next: start + page.length < rows.length ? String(start + page.length) : null };
    }
    // records:read answers the record's own value, or null when there is no such record.
    if (address === '@own-records' && method === 'records:read') return kept.get(input.id)?.value ?? null;
    if (address === '@tools' && method === 'tools:run') {
      const row = ROWS.find(one => one.id === input.tool);
      seen.runs.push({ tool: input.tool, records: input.input.records.length, key });
      const result = await moves[row.invoke.argv.at(-1)]({ input: input.input, task: { request_key: key } }, { now });
      if (beforeWrite) beforeWrite(kept);
      return { state: 'completed', output: { result } };
    }
    if (address === '@own-records' && method === 'records:write') {
      seen.writes.push(input.records.map(write => write.id));
      for (const { id, type, value, expected } of input.records) {
        const current = kept.get(id) ?? null;
        if (expected === null ? current : (!current || current.type !== expected.type || !same(current.value, expected.value))) {
          throw Object.assign(new Error(`${CHANGED}: ${id}`), { code: CHANGED });
        }
        if (value === null) kept.delete(id);
        else kept.set(id, { id, type, value });
      }
      return { kept: input.records.length };
    }
    throw new Error(`unexpected ${address} ${method}`);
  };
  return { resource, kept, seen };
}

test('the caller reads every task page by page, hands them to the row, and keeps the one write the row answers', async () => {
  const account = fakeAccount([...PEOPLE, task('record:calendar-task:a', 'To do'), task('record:calendar-task:b', 'To do'), task('record:calendar-task:c', 'Done'), task('record:calendar-task:d', 'To do'), task('record:calendar-task:e', 'To do')]);
  const read = await readFor(account.resource, { tasks: { statuses: ['To do'] }, types: ['ai'] });
  assert.deepEqual(read.map(record => record.id).sort(), ['ai:east', 'ai:north', 'record:calendar-task:a', 'record:calendar-task:b', 'record:calendar-task:d', 'record:calendar-task:e']);
  const outcome = await runTaskMove(account.resource, { tool: 'tool:take-a-task', input: { as: 'ai:north' }, key: 'take-1', read: { tasks: { statuses: ['To do'] }, types: ['ai'] } });
  assert.equal(outcome.kept, true);
  assert.equal(outcome.result.taken.id, 'record:calendar-task:a');
  assert.equal(account.kept.get('record:calendar-task:a').value.status, 'In progress');
  assert.equal(account.seen.runs[0].records, 6, 'the row was handed every task and person it needs');
  assert.deepEqual(account.seen.writes, [['record:calendar-task:a']]);
});

test('a record changed after the row answered is refused whole: kept false with reason changed, and the other record is not written', async () => {
  const account = fakeAccount([...PEOPLE, task('record:calendar-task:a', 'To do'), task('record:calendar-task:b', 'To do')], {
    beforeWrite: kept => kept.set('record:calendar-task:a', { ...kept.get('record:calendar-task:a'), value: { ...kept.get('record:calendar-task:a').value, status: 'Not needed' } }),
  });
  const outcome = await runTaskMove(account.resource, { tool: 'tool:take-a-task', input: { as: 'ai:north' }, key: 'take-2', read: { tasks: { statuses: ['To do'] } } });
  assert.deepEqual({ kept: outcome.kept, reason: outcome.reason }, { kept: false, reason: 'changed' });
  assert.equal(account.kept.get('record:calendar-task:a').value.status, 'Not needed', 'the caller wrote nothing over the change');
  assert.equal(account.kept.get('record:calendar-task:b').value.status, 'To do');
});

test('a take that finds nothing answers taken null and writes nothing', async () => {
  const account = fakeAccount([...PEOPLE, task('record:calendar-task:a', 'To do', { assignees: ['ai:east'] })]);
  const outcome = await runTaskMove(account.resource, { tool: 'tool:take-a-task', input: { as: 'ai:north' }, key: 'take-3', read: { tasks: { statuses: ['To do'] } } });
  assert.equal(outcome.kept, true);
  assert.equal(outcome.result.taken, null);
  assert.deepEqual(account.seen.writes, []);
});

test('named records are read by id, and a record that is not there is left out', async () => {
  const account = fakeAccount([...PEOPLE, task('record:calendar-task:a', 'To do')]);
  const read = await readFor(account.resource, { ids: [{ type: 'calendar-task', id: 'record:calendar-task:a' }, { type: 'person', id: 'person:none' }] });
  assert.deepEqual(read.map(record => record.id), ['record:calendar-task:a']);
});
