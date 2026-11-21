// tools/workspace-screens/test/send-to-seeds.test.ts
// The composer's message becomes one seed row through the one door's tool run: the exact tool input is checked, a
// message sent again is the same row, and a refusal is said in its own words.
import assert from 'node:assert/strict';
import test from 'node:test';
import seeds from '../web/src/workspace/send-to-seeds.json' with { type: 'json' };
import { keepComposerSeed, seedRoute, type ComposerSeed } from '../web/src/workspace/send-to-seeds.ts';

const body: ComposerSeed = { client_id: 'draft-1', text: 'Plan the Friday call', at: '2026-11-21T20:14:00.000Z', files: [{ identity: 'file-a' }] };
const placesRow = { rows: [{ value: JSON.stringify({ roles: { 'messages-to-my-ais': { credential_name: 'pursuit-connection', table: 'seeds' } } }) }] };

/** A stand-in door: it records each tool run's input and key, and answers from the given rows in turn. */
function standIn(answers: unknown[]) {
  const runs: { tool: string; input: Record<string, unknown>; key?: string }[] = [];
  const run = async (tool: string, input: Record<string, unknown>, key?: string) => {
    runs.push({ tool, input, key });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { tool, exit_code: 0, result: answer };
  };
  return { runs, run: run as Parameters<typeof keepComposerSeed>[1] };
}

test('a composer message is one tool run on the owner-places role, then one insert into the seeds table with its key', async () => {
  const door = standIn([placesRow, { rows: [{ id: 'composer:draft-1', kept_at: '2026-11-21T20:14:02.000Z' }] }]);
  const kept = await keepComposerSeed(body, door.run);

  assert.equal(door.runs.length, 2);
  assert.deepEqual(door.runs[0], {
    tool: 'tool:run-sql-in-my-database',
    input: { credential_name: 'own-rows-postgres-connection', sql: 'select value from public.workspace_records where label = $1', params: ['owner-places'], statement_timeout_ms: 5000 },
    key: undefined,
  });
  const insert = door.runs[1];
  assert.equal(insert.tool, 'tool:run-sql-in-my-database');
  assert.equal(insert.key, 'composer:draft-1');
  assert.equal(insert.input.credential_name, 'pursuit-connection');
  assert.equal(insert.input.statement_timeout_ms, 5000);
  assert.match(String(insert.input.sql), /^with ins as \(insert into seeds \(id, words, came_from, media, at, kept_at\)/);
  assert.match(String(insert.input.sql), /on conflict \(id\) do nothing/);
  assert.deepEqual(insert.input.params, [
    'composer:draft-1',
    'Plan the Friday call',
    JSON.stringify({ source: 'composer', screen: '', at: '2026-11-21T20:14:00.000Z', channel: 'web' }),
    JSON.stringify([{ identity: 'file-a' }]),
    '2026-11-21T20:14:00.000Z',
  ]);
  assert.equal(kept.message_id, 'composer:draft-1');
  assert.equal(kept.kept_at, '2026-11-21T20:14:02.000Z');
  assert.match(kept.message, /^Sent at \d{1,2}:\d{2} (AM|PM)\.$/);
});

test('a message with no files keeps its media empty, and names the anchor it was sent about', async () => {
  const door = standIn([placesRow, { rows: [{ id: 'composer:draft-2', kept_at: '2026-11-21T20:15:00.000Z' }] }]);
  await keepComposerSeed({ client_id: 'draft-2', text: 'Look at this', at: '2026-11-21T20:15:00.000Z', anchor: { record: 'r1' }, reply_to: 'x9' }, door.run);
  const params = door.runs[1].input.params as unknown[];
  assert.equal(params[3], null);
  assert.deepEqual(JSON.parse(String(params[2])), { source: 'composer', screen: '', at: '2026-11-21T20:15:00.000Z', channel: 'web', anchor: { record: 'r1' }, reply_to: 'x9' });
});

test('the same draft sent again asks for the same row and key, so the second send is the same seed', async () => {
  const first = standIn([placesRow, { rows: [{ id: 'composer:draft-1', kept_at: '2026-11-21T20:14:02.000Z' }] }]);
  const again = standIn([placesRow, { rows: [{ id: 'composer:draft-1', kept_at: '2026-11-21T20:14:02.000Z' }] }]);
  const a = await keepComposerSeed(body, first.run);
  const b = await keepComposerSeed(body, again.run);
  assert.deepEqual(first.runs[1].input.params, again.runs[1].input.params);
  assert.equal(first.runs[1].key, again.runs[1].key);
  assert.deepEqual(a, b);
});

test('a refusal from the account is thrown in its own words', async () => {
  const door = standIn([new Error('The database refused the statement: permission denied for table seeds')]);
  await assert.rejects(keepComposerSeed(body, door.run), { message: 'The database refused the statement: permission denied for table seeds' });
});

test('no owner-places role for messages is said as not kept, with no insert run', async () => {
  const door = standIn([{ rows: [{ value: JSON.stringify({ roles: { goals: { credential_name: 'own-rows-postgres-connection', table: 'home_goals' } } }) }] }]);
  await assert.rejects(keepComposerSeed(body, door.run), { message: seeds.no_place });
  assert.equal(door.runs.length, 1);
});

test('the route is the composer seed path, and its key travels as client_id', () => {
  assert.deepEqual(seedRoute, { path: 'composer-seed', key_field: 'client_id' });
});
