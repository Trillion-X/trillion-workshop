// tools/conversations: the two rows are the shape the engine runs, and each command, run the way the engine runs it
// (the granted folder in argv, the input on standard input, the answer on the last line, /opt/conversations laid on
// this folder), answers over a made-up export in a made-up folder. Needs python3 (standard library only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const row = id => rows.find(item => item.id === id);
const skip = spawnSync('python3', ['--version']).status === 0 ? false : 'needs python3';

// The command a row runs: its argv with /opt/conversations laid on this folder and the folder grant filled.
function run(item, granted, input) {
  const argv = item.invoke.argv.map(part => (typeof part === 'string' ? part.replace('/opt/conversations', folder) : granted));
  const ran = spawnSync(argv[0], ['-B', ...argv.slice(1)], { input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

function exportFolder(t) {
  const root = mkdtempSync(join(tmpdir(), 'conversations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'saved'), { recursive: true });
  writeFileSync(join(root, 'saved', 'orders.json'), JSON.stringify({
    self_id: 'U1',
    channels: [{ id: 'C1', name: 'bakery-orders', messages: [
      { ts: '1700000000.000100', user: 'U1', text: 'Fresh rye is up' },
      { ts: '1700000060.000200', user: 'U2', user_profile: { real_name: 'Rosa' }, text: 'Two loaves please' },
    ] }],
  }));
  return root;
}

test('the read row runs on the person\'s computer over a granted folder, reaches no internet, and packs only read-data', () => {
  const item = row('tool:read-an-export-of-my-conversations');
  assert.equal(item.invoke.kind, 'computer');
  assert.deepEqual(item.invoke.capabilities, ['read-a-folder']);
  assert.notEqual(item.invoke.internet, true);
  assert.deepEqual(item.placements, ['placement:your-computer']);
  assert.equal(item.result_selector, '$.result');
  assert.deepEqual(item.invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
  assert.deepEqual(item.invoke.files.package_files, { package: 'conversations', paths: ['read-data'], at: '/opt/conversations' });
  assert.deepEqual(item.input_schema.required, ['file']);
});

test('the read row\'s command answers an export as threads, atoms and conversations for the owner that keeps messages', { skip }, t => {
  const { status, answer } = run(row('tool:read-an-export-of-my-conversations'), exportFolder(t), { file: 'saved/orders.json' });
  assert.equal(status, 0);
  assert.equal(answer.result.source, 'slack-messages');
  assert.equal(answer.result.threads.length, 1);
  assert.deepEqual(answer.result.conversations[0].messages.map(message => [message.speaker, message.text]),
    [['person', 'Fresh rye is up'], ['Rosa', 'Two loaves please']]);
  assert.equal(answer.result.conversations[0].app, 'Slack');
  assert.deepEqual(answer.result.rejections, []);
});

test('the read row\'s command refuses a file outside the folder and says what to do', { skip }, t => {
  const { status, answer } = run(row('tool:read-an-export-of-my-conversations'), exportFolder(t), { file: '../elsewhere.json', source: 'slack-messages' });
  assert.equal(status, 2);
  assert.match(answer.error, /outside the folder you granted; name a file inside it/);
});

test('the list row runs in a container with no folder and its sample run is the line the engine checks', { skip }, () => {
  const item = row('tool:list-the-kinds-of-conversation-export-i-can-read');
  assert.equal(item.invoke.kind, 'container');
  assert.notEqual(item.invoke.internet, true);
  const { status, answer } = run(item, null, undefined);
  assert.equal(status, 0);
  const [check] = item.verify;
  assert.equal(check.output_selector, '$.said');
  assert.ok(answer.result.said.includes(check.contains));
  const ids = answer.result.sources.map(source => source.id);
  assert.ok(ids.includes('slack-messages') && ids.includes('imessage-database') && ids.includes('gmail-page'));
  assert.deepEqual(answer.result.sources.find(source => source.id === 'gmail-page').needs, ['mailbox_address']);
  assert.deepEqual(answer.result.sources.find(source => source.id === 'web-conversation-capture').needs, ['expected_provider']);
});

test('every row has the words an AI finds it by and a schema for what it takes and gives', () => {
  for (const item of rows) {
    assert.ok(item.job.length > 40 && item.label && item.description, item.id);
    assert.equal(item.input_schema.type, 'object', item.id);
    assert.equal(item.output_schema.type, 'object', item.id);
    assert.equal(item.maker, 'maker:conversations');
  }
});
