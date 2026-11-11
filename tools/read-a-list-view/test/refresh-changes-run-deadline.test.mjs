// read-a-list-view on a made-up bakery's chores: --changes reconciles only the named recipes, --run-id keys a refresh's
// writes by its commit so a retry answers its first answers, and --deadline-ms ends a refresh that runs past it with an
// outcome the caller can read. The recipes are played by a folder the fake tool answers, filtered by the `paths` it is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { refreshRowSources } from '../read-data/list-view.mjs';

const READER = fileURLToPath(new URL('../do-work/read-list-view.mjs', import.meta.url));
const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}', view_type: 'list-view' };
const RUN = 'a'.repeat(40);
const recipe = (name, minutes) => ({ id: `/${name}.md`, values: { 'note.chore': `bake ${name}`, 'note.minutes': minutes } });

function bakery(folder) {
  const records = new Map([
    ['list:chores', { label: 'Chores', row_type: 'chore', title_field: 'chore', fields: [{ id: 'chore', kind: 'text' }, { id: 'minutes', kind: 'number' }],
      row_sources: [{ source: 'documents', of: '/recipes' }] }],
  ]);
  const writes = [];
  const door = {
    read: async (type, id) => (records.has(id) ? records.get(id) : null),
    list: async ({ type, limit, after, prefix = `${type}:` }) => {
      const ids = [...records.keys()].filter(id => id.startsWith(prefix)).sort().reverse().filter(id => !after || id < after);
      const shown = ids.slice(0, limit);
      return { records: shown.map(id => ({ id, type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
    },
    run: async (tool, input) => {
      door.asked.push({ tool, input });
      const rows = folder.filter(row => !input.paths || input.paths.includes(row.id));
      return { exit_code: 0, result: { rows, next: null } };
    },
    write: async (rows, { key }) => {
      writes.push({ rows, key });
      for (const row of rows) {
        if (row.value === null) records.delete(row.id);
        else records.set(row.id, row.value);
      }
      return { changed: true };
    },
    asked: [],
  };
  return { door, records, writes };
}

const refresh = (door, input) => refreshRowSources({ names: NAMES, list: 'chores', ...input }, door);
const recordOf = (records, name) => records.get(`record:chore:documents~${encodeURIComponent(name)}`);

test('--changes reconciles only the named recipes: each is read by its own path, the others are left alone', async () => {
  const folder = [recipe('bread', 40), recipe('buns', 25), recipe('scones', 15), recipe('tart', 55)];
  const { door, records } = bakery(folder);
  await refresh(door, {});
  door.asked.length = 0;
  folder[0] = recipe('bread', 45);
  folder.push(recipe('rolls', 12));
  folder.splice(3, 1);
  const answer = await refresh(door, { changes: { documents: { paths: ['/bread.md', '/rolls.md'], removed: ['/tart.md'] } } });
  assert.deepEqual(answer.sources, [{ source: 'documents', rows: 2, written: 2, removed: 1, unchanged: 0, refused: [] }]);
  assert.deepEqual(door.asked.map(call => call.input.paths), [['/bread.md'], ['/rolls.md']], 'one tool call per changed path');
  assert.deepEqual(recordOf(records, '/bread.md'), { 'note.chore': 'bake bread', 'note.minutes': 45 });
  assert.deepEqual(recordOf(records, '/rolls.md'), { 'note.chore': 'bake rolls', 'note.minutes': 12 });
  assert.equal(recordOf(records, '/tart.md'), undefined, 'a removed document loses its row');
  assert.deepEqual(recordOf(records, '/scones.md'), { 'note.chore': 'bake scones', 'note.minutes': 15 }, 'an unnamed document is untouched');
});

test('a changed document whose row is unchanged writes nothing', async () => {
  const folder = [recipe('bread', 40)];
  const { door, writes } = bakery(folder);
  await refresh(door, {});
  const before = writes.length;
  const answer = await refresh(door, { changes: { documents: { paths: ['/bread.md'], removed: [] } } });
  assert.deepEqual(answer.sources[0], { source: 'documents', rows: 1, written: 0, removed: 0, unchanged: 1, refused: [] });
  assert.equal(writes.length, before);
});

test('a changed document the source no longer answers keeps its old row: a deletion is named in removed, never inferred', async () => {
  const folder = [recipe('bread', 40)];
  const { door, records } = bakery(folder);
  await refresh(door, {});
  folder.length = 0;
  await assert.rejects(refresh(door, { changes: { documents: { paths: ['/bread.md'], removed: [] } } }),
    error => error.code === 'source_changed_path_unanswered');
  assert.deepEqual(recordOf(records, '/bread.md'), { 'note.chore': 'bake bread', 'note.minutes': 40 });
});

test('--changes refuses a source the refresh does not select, a traversal, a path named twice, and an empty change', async () => {
  const { door } = bakery([]);
  const refused = [
    { documents: { paths: ['/a/../b.md'], removed: [] } },
    { documents: { paths: ['/a.md'], removed: ['/a.md'] } },
    { documents: { paths: [], removed: [] } },
    { recipes: { paths: ['/a.md'], removed: [] } },
    ['/a.md'],
  ];
  for (const changes of refused) {
    await assert.rejects(refresh(door, { changes }), error => error.code === 'bad_input', JSON.stringify(changes));
  }
});

test('--run-id keys every write by its commit: a refresh sent again for the same commit keys its writes the same', async () => {
  const folder = [recipe('bread', 40), recipe('buns', 25)];
  const first = bakery(folder);
  await refresh(first.door, { run_id: RUN });
  const keys = first.writes.map(write => write.key);
  assert.ok(keys.length > 0 && keys.every(key => key.startsWith(`refresh:chores:documents:${RUN}`)), keys.join(' '));
  const again = bakery(folder);
  await refresh(again.door, { run_id: RUN });
  assert.deepEqual(again.writes.map(write => write.key), keys, 'the same commit gives the same keys, so a retry answers its first answers');
  const other = bakery(folder);
  await refresh(other.door, { run_id: 'b'.repeat(40) });
  assert.notDeepEqual(other.writes.map(write => write.key), keys, 'another commit keys its writes apart');
});

test('--run-id refuses anything but a full lowercase commit identity', async () => {
  const { door } = bakery([]);
  for (const run_id of ['ABCDEF', 'g'.repeat(40), 'a'.repeat(39)]) {
    await assert.rejects(refresh(door, { run_id }), error => error.code === 'bad_input', run_id);
  }
});

test('--deadline-ms already passed refuses before any request, reported as not_started', async () => {
  const { stderr } = await promisify(execFile)(process.execPath, [READER, '--config', join(tmpdir(), 'no-such-config.json'),
    '--refresh', 'chores', '--deadline-ms', String(Date.now() - 1000)]).then(() => assert.fail('should refuse'), error => error);
  assert.match(stderr, /outcome=not_started/);
});

test('--deadline-ms that passes while the door has not answered ends the refresh, reported as unknown, within the deadline', async () => {
  const server = createServer(() => {});
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const dir = await mkdtemp(join(tmpdir(), 'read-list-view-deadline-'));
  const key = join(dir, 'key.txt');
  await writeFile(key, 'synthetic-test-key\n');
  const config = join(dir, 'config.json');
  await writeFile(config, JSON.stringify({
    transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { key_file: key } },
    records: { address: 'records:test', read_method: 'records:read', list_method: 'records:list' },
    tools: { address: 'tools:test', run_method: 'tools:run' },
    names: NAMES,
  }));
  const started = Date.now();
  try {
    const failure = await promisify(execFile)(process.execPath, [READER, '--config', config, '--refresh', 'chores',
      '--deadline-ms', String(Date.now() + 400)], { timeout: 20000 }).then(() => assert.fail('should not finish'), error => error);
    assert.equal(failure.code, 2);
    assert.match(failure.stderr, /outcome=unknown/);
    assert.ok(Date.now() - started < 10000, 'the process ends at the deadline, not when the door answers');
  } finally {
    server.close();
  }
});
