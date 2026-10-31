// tools/save-what-you-watch-and-read: the three rows are the shape the engine runs, and each command, run the way the
// engine runs it (the granted folder in argv, the input on standard input, the answer on the last line, /opt/<folder>
// laid on the tool folders), answers over made-up files in a made-up folder. Needs python3 (standard library only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const tools = resolve(folder, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const row = id => rows.find(item => item.id === id);
const skip = spawnSync('python3', ['--version']).status === 0 ? false : 'needs python3';

// The command a row runs: its argv with /opt/<folder> laid on that tool folder and the folder grant filled.
function run(item, granted, input) {
  const argv = item.invoke.argv.map(part => (typeof part === 'string'
    ? part.replace(/^\/opt\/([a-z-]+)/, (_, name) => join(tools, name))
    : granted));
  const ran = spawnSync(argv[0], ['-B', ...argv.slice(1)], { input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

function madeUpFolder(t) {
  const root = mkdtempSync(join(tmpdir(), 'save-what-you-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'saved'), { recursive: true });
  writeFileSync(join(root, 'saved', 'bookmarks.json'), JSON.stringify({
    user_id: '1',
    bookmarks: [
      { id: '9001', text: 'Fresh rye is up', created_at: '2026-01-02T08:00:00Z', author_id: 'baker_rosa' },
      { id: '9002', text: 'Two loaves please', created_at: '2026-01-02T09:00:00Z', author_id: 'ben_orders' },
    ],
  }));
  for (const [name, seconds] of [['one.txt', 1_700_000_100], ['two.txt', 1_700_000_200]]) {
    writeFileSync(join(root, 'saved', name), name);
    utimesSync(join(root, 'saved', name), seconds, seconds);
  }
  return root;
}

test('the two folder rows run on the person\'s computer over a granted folder, reach no internet, and pack their folders', () => {
  for (const id of ['tool:read-my-saved-bookmarks-and-pins', 'tool:find-new-or-changed-files']) {
    const item = row(id);
    assert.equal(item.invoke.kind, 'computer', id);
    assert.deepEqual(item.invoke.capabilities, ['read-a-folder'], id);
    assert.notEqual(item.invoke.internet, true, id);
    assert.deepEqual(item.placements, ['placement:your-computer'], id);
    assert.equal(item.result_selector, '$.result', id);
    assert.ok(item.invoke.argv.some(part => part.fill?.field === 'grants.read-a-folder.folder'), id);
    assert.deepEqual(item.invoke.files.package_files.map(spec => spec.package), ['conversations', 'save-what-you-watch-and-read'], id);
  }
});

test('the observation row runs in a container with no folder and its sample run is the line the engine checks', { skip }, () => {
  const item = row('tool:observe-something-i-watched-or-read');
  assert.equal(item.invoke.kind, 'container');
  assert.notEqual(item.invoke.internet, true);
  const [check] = item.verify;
  const { status, answer } = run(item, null, check.input);
  assert.equal(status, 0);
  assert.ok(answer.result.said.includes(check.contains));
  assert.equal(answer.result.observation.payload.host, 'example.org');
  assert.match(answer.result.observation.id, /^1f:[0-9a-f]{64}$/);
});

test('the bookmarks row\'s command reads an export as one thread and one atom for each saved item', { skip }, t => {
  const { status, answer } = run(row('tool:read-my-saved-bookmarks-and-pins'), madeUpFolder(t), { file: 'saved/bookmarks.json' });
  assert.equal(status, 0);
  assert.equal(answer.result.source, 'x-bookmarks');
  assert.equal(answer.result.threads.length, 2);
  assert.equal(answer.result.atoms.length, 2);
  assert.deepEqual(answer.result.atoms.map(atom => atom.content.text), ['Fresh rye is up', 'Two loaves please']);
  assert.deepEqual(answer.result.rejections, []);
});

test('the files row\'s command finds files, finds nothing on a re-run with next_since, and refuses a path outside the folder', { skip }, t => {
  const item = row('tool:find-new-or-changed-files');
  const granted = madeUpFolder(t);
  const first = run(item, granted, { source_ref: 'source:saved', glob: 'saved/*.txt' });
  assert.equal(first.status, 0);
  assert.deepEqual(first.answer.result.observations.map(o => o.native_ref), ['saved/two.txt', 'saved/one.txt']);
  const again = run(item, granted, { source_ref: 'source:saved', glob: 'saved/*.txt', since: first.answer.result.next_since });
  assert.deepEqual(again.answer.result.observations, []);
  const outside = run(item, granted, { source_ref: 'source:saved', under: '..' });
  assert.equal(outside.status, 2);
  assert.match(outside.answer.error, /outside the folder you granted/);
});

test('every row has the words an AI finds it by and a schema for what it takes and gives', () => {
  for (const item of rows) {
    assert.ok(item.job.length > 40 && item.label && item.description, item.id);
    assert.equal(item.input_schema.type, 'object', item.id);
    assert.equal(item.output_schema.type, 'object', item.id);
    assert.equal(item.maker, 'maker:save-what-you-watch-and-read');
  }
});
