// tools/check-a-folder-against-my-rules: the two rows are the shape the engine runs on the person's computer, and
// each command, run the way the engine runs it (the granted folder in argv, the input on standard input, the answer
// on the last line), answers over a made-up folder that is not a git repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const row = id => rows.find(item => item.id === id);

function run(command, granted, input) {
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', command), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-my-folder-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'old-copy.txt'), 'kept\n');
  writeFileSync(join(root, 'src', 'main.mjs'), 'const lock = "acme-lock";\nconst fine = 1;\n');
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'main.mjs'), 'const lock = "acme-lock";\n');
  return root;
}

const NO_BRAND = { kind: 'source-file-rule', id: 'no-brand-in-a-lock-name', why: 'a lock is unique by its id; a brand in front adds nothing',
  scope: { path_matches: '\\.mjs$' }, violation: { unit: { split: '\\n' }, forbidden: { pattern: 'acme', flags: 'i' } }, message: 'a brand in a lock name' };

test('both rows run on the person\'s computer with only the folder capability they need, and reach no internet', () => {
  assert.deepEqual(rows.map(item => item.invoke.capabilities), [['read-a-folder'], ['change-a-folder']]);
  for (const item of rows) {
    assert.equal(item.invoke.kind, 'computer');
    assert.notEqual(item.invoke.internet, true);
    assert.deepEqual(item.placements, ['placement:your-computer']);
    assert.equal(item.result_selector, '$.result');
    assert.deepEqual(item.invoke.argv.at(-1), { fill: { from: 'task', field: `grants.${item.invoke.capabilities[0]}.folder` } });
  }
});

test('a folder that is not a repository is judged file by file, leaving out what a project keeps others\' code in', t => {
  const root = project(t);
  const { status, answer } = run('check-my-folder.mjs', root, { rules: [NO_BRAND] });
  assert.equal(status, 0);
  assert.equal(answer.result.passed, false);
  assert.match(answer.result.scanned_from, /every file in the folder/);
  assert.deepEqual(answer.result.violations.map(item => [item.rule_id, item.path, item.line]), [['no-brand-in-a-lock-name', 'src/main.mjs', 1]]);
  assert.equal(answer.result.files, 1);
});

test('a clean folder passes, and a rule that no file met is not a pass', t => {
  const root = project(t);
  const clean = run('check-my-folder.mjs', root, { rules: [{ ...NO_BRAND, violation: { ...NO_BRAND.violation, forbidden: { pattern: 'a-string-nothing-holds' } } }] });
  assert.equal(clean.status, 0);
  assert.equal(clean.answer.result.passed, true);
  const unmet = run('check-my-folder.mjs', root, { rules: [{ ...NO_BRAND, scope: { path_matches: '\\.never$' } }] });
  assert.equal(unmet.answer.result.passed, false);
  assert.equal(unmet.answer.result.no_applicable_rule, true);
});

test('rows may arrive as records, and a recorded baseline is compared in both directions', t => {
  const root = project(t);
  const recorded = { known_findings: { 'no-brand-in-a-lock-name': ['src/main.mjs:1'] } };
  const same = run('check-my-folder.mjs', root, { rules: [{ payload: NO_BRAND }], recorded });
  assert.equal(same.answer.result.passed, true, JSON.stringify(same.answer));
  assert.deepEqual(same.answer.result.ratchet.appeared, []);
  const paidOff = run('check-my-folder.mjs', root, { rules: [{ payload: NO_BRAND }], recorded: { known_findings: { 'no-brand-in-a-lock-name': ['src/main.mjs:1', 'src/main.mjs:2'] } } });
  assert.equal(paidOff.answer.result.passed, false);
});

test('it refuses, in words, rather than report a clean run it cannot stand behind', t => {
  const root = project(t);
  assert.match(run('check-my-folder.mjs', root, { rules: [] }).answer.error, /no source-file-rule records/);
  assert.match(run('check-my-folder.mjs', root, { rules: [NO_BRAND, NO_BRAND] }).answer.error, /share the id/);
  assert.match(run('check-my-folder.mjs', root, {}).answer.error, /give rules/);
  assert.match(run('check-my-folder.mjs', join(root, 'absent'), { rules: [NO_BRAND] }).answer.error, /granted folder/);
});

test('a control byte is rewritten as its escape, and a path that leaves the folder or is a link is refused', t => {
  const root = project(t);
  const raw = String.fromCharCode(0);
  writeFileSync(join(root, 'src', 'key.mjs'), `export const joined = ["a", "b"].join("${raw}");\n`);
  writeFileSync(join(root, 'outside.mjs'), `export const x = "${raw}";\n`);
  symlinkSync(join(root, 'outside.mjs'), join(root, 'src', 'link.mjs'));
  const { answer } = run('repair-control-bytes-in-my-folder.mjs', join(root, 'src'), { files: ['key.mjs', '../outside.mjs', 'link.mjs', 'main.mjs'] });
  assert.equal(answer.result.rewritten, 1);
  assert.equal(readFileSync(join(root, 'src', 'key.mjs'), 'utf8'), 'export const joined = ["a", "b"].join("\\u0000");\n');
  assert.equal(readFileSync(join(root, 'outside.mjs'), 'utf8'), `export const x = "${raw}";\n`, 'a file outside the folder is untouched');
  const by = Object.fromEntries(answer.result.each.map(item => [item.path, item]));
  assert.equal(by['../outside.mjs'].changed, false);
  assert.match(by['../outside.mjs'].why, /not-repository-relative/);
  assert.match(by['link.mjs'].why, /alias/);
  assert.equal(by['main.mjs'].why, 'no raw control character');
});
