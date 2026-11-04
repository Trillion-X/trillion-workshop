import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failing, judgeNames, wordsOf } from '../do-work/check-new-names.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'do-work', 'check-new-names.mjs');

// Rules of the shape a check row carries; the words here are made up for the test except the ones the cases need.
const RULES = {
  repositories: ['example-owner/example-engine'],
  words: [
    { why: 'a status, which changes while the name stays', words: ['legacy', 'kept', 'old'] },
    { why: 'a technical metaphor, which names no job', words: ['boot', 'custody', 'engine'] },
  ],
  patterns: [
    { why: 'a codename: letters and digits run together that no reader can point at', pattern: '^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*[0-9])[a-z0-9]+$' },
    { why: 'a time, which is past as soon as it is written', pattern: '^(19|20)[0-9]{2}([0-9]{4})?$' },
  ],
  passes: ['blake3', 'x86'],
};

function repository(origin = 'git@example.test:example-owner/example-engine.git') {
  const root = mkdtempSync(join(tmpdir(), 'check-new-names-'));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.test');
  run('config', 'user.name', 'test');
  run('remote', 'add', 'origin', origin);
  const write = (path) => { mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), 'x\n'); run('add', path); };
  return { root, run, write };
}

test('a name is read as words, its extension left out', () => {
  assert.deepEqual(wordsOf('legacy_kept.rs', true), ['legacy', 'kept']);
  assert.deepEqual(wordsOf('nativeBoot', false), ['native', 'boot']);
  assert.deepEqual(wordsOf('record-store.v2.json', true), ['record', 'store', 'v2']);
});

test('codenames, statuses, times and metaphors fail; plain names and outside names pass', () => {
  for (const name of ['s2h', 'legacy_kept', 'native_boot', 'body_custody', 'notes_2026']) assert.ok(failing(name, false, RULES), name);
  for (const name of ['record_store', 'postgres', 'blake3', 'x86']) assert.equal(failing(name, false, RULES), null, name);
});

test('a commit adding a bad name is refused naming the word and why; a folder already there is not judged again', () => {
  const { root, run, write } = repository();
  write('src/s2h/reader.rs');
  run('commit', '-q', '-m', 'base');
  write('src/s2h/writer.rs');
  write('src/record_store/mod.rs');
  write('src/postgres.rs');
  assert.deepEqual(judgeNames({ root, span: { staged: true }, rules: RULES }).refused, []);
  write('src/legacy_kept/mod.rs');
  write('src/body_custody.rs');
  const result = judgeNames({ root, span: { staged: true }, rules: RULES });
  assert.deepEqual(result.refused.map((one) => [one.path, one.word]), [['src/body_custody.rs', 'custody'], ['src/legacy_kept', 'legacy']]);
});

test('a renamed file is a new name; a repository the rules do not name is not judged', () => {
  const { root, run, write } = repository();
  write('src/reader.rs');
  run('commit', '-q', '-m', 'base');
  run('mv', 'src/reader.rs', 'src/native_boot.rs');
  assert.deepEqual(judgeNames({ root, span: { staged: true }, rules: RULES }).refused.map((one) => one.word), ['boot']);
  const other = repository('git@example.test:example-owner/another.git');
  other.write('src/s2h.rs');
  assert.equal(judgeNames({ root: other.root, span: { staged: true }, rules: RULES }).valid, true);
});

test('run for a command: a commit is judged and refused with exit 2, any other command passes in silence', () => {
  const { root, write } = repository();
  write('src/s2h.rs');
  const run = (command) => spawnSync(process.execPath, [SCRIPT, '--root', root, '--for-command', command, '--rules-json', JSON.stringify(RULES)], { encoding: 'utf8' });
  const commit = run('git commit -m "add it"');
  assert.equal(commit.status, 2);
  assert.match(commit.stderr, /src\/s2h\.rs: "s2h" is a codename/);
  const listing = run('ls src');
  assert.equal(listing.status, 0);
  assert.equal(listing.stderr, '');
});

test('as the Workshop tool: rules on stdin, the staged names judged, the refusal a result on the last line', () => {
  const { root, write } = repository();
  write('src/legacy_kept.rs');
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--input-on-stdin'], { input: JSON.stringify({ rules: RULES }), encoding: 'utf8' });
  assert.equal(ran.status, 0);
  const { result } = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.equal(result.valid, false);
  assert.deepEqual(result.refused.map((one) => one.word), ['legacy']);
  const none = spawnSync(process.execPath, [SCRIPT, '--root', root, '--input-on-stdin'], { input: '{}', encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /give rules/);
});
