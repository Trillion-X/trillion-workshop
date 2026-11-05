// Runs the command for real on made-up rows and made-up caption files, and checks what the tool promises: nothing is written
// while a quote fails, every file is written when all hold, the index gets the family once, and a bad request is refused with
// what to fix. Needs python3 only.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'turn_quotes_into_device_rows.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const run = (...argv) => spawnSync('python3', [script, ...argv], { encoding: 'utf8' });
const result = out => JSON.parse(out.stdout.trim().split('\n').pop()).result;

const settings = {
  family: 'garden-tips', title: 'Garden tips', introduction: 'Made-up rows.',
  channels: { vidA: ['BenchTalk', 'Potting basics'] }, groups: ['Care'],
  rows: [{ group: 'Care', name: 'say the rule, then the reason', also: [], what: 'The viewer remembers it.',
    seen: [['vidA', 'water the roots, not the leaves']], fits: 'how-to', cost: 'low', verification: 'verified' }],
  columns: [{ head: 'tip', parts: [{ text: '**{name}**' }] }, { head: 'seen in', parts: [{ text: '{seen_text}' }] }],
  file_head: ['# {title}', ''], index_marker: '<!-- {family} -->', seen_quote: '{channel}/{video} [{stamp}] "{quote}"',
  seen_join: '; ', list_join: '; ', checked_fields: ['group', 'name'],
};

// The person's list:settings row for this tool, as records:read gives it (scope: the piece, i.e. the batch of rows).
const record = (values, { scopeId = values.family, tool = 'tool:turn-caption-quotes-into-analysis-device-rows', status = 'active' } = {}) => ({
  id: `record:setting:turn-caption-quotes-into-analysis-device-rows~piece~${scopeId}`, type: 'record:setting',
  value: { name: `device rows: ${scopeId}`, tool, scope_kind: 'piece', scope_id: scopeId, settings: JSON.stringify(values),
    from: 'made-up/build.py@0000000', status } });

let work, captions;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'device-rows-'));
  mkdirSync(join(work, 'captions'));
  writeFileSync(join(work, 'captions', 'vidA.en.json3'), JSON.stringify({ events: [
    { tStartMs: 0, segs: [{ utf8: 'hello' }] }, { tStartMs: 65400, segs: [{ utf8: 'Water the roots, not the leaves' }] }] }));
  captions = join(work, 'captions', '{video}.*json3');
  writeFileSync(join(work, 'settings.json'), JSON.stringify(record(settings)));
  writeFileSync(join(work, 'index.md'), '# Index\n');
});

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:turn-caption-quotes-into-analysis-device-rows');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.ok(row.invoke.run.includes('tools/turn-caption-quotes-into-analysis-device-rows/do-work/turn_quotes_into_device_rows.py'));
  assert.ok(existsSync(script));
});

test('the pure readers keep their promises', () => {
  const out = spawnSync('python3', [join(folder, 'test', 'test_device_rows.py')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
});

test('every quote holds: the family file, the index and the checked rows are written', () => {
  const files = ['--family-file', join(work, 'family.md'), '--index-file', join(work, 'index.md'), '--checked-file', join(work, 'checked.json')];
  const out = run('--settings-record', join(work, 'settings.json'), '--captions', captions, ...files);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(result(out), { rows: 1, bad: [], written: [files[1], files[3], files[5]], index: 'added' });
  assert.equal(readFileSync(files[1], 'utf8'),
    '# Garden tips\n\n## Care\n\n| tip | seen in |\n|---|---|\n| **say the rule, then the reason** | BenchTalk/vidA [1:05] "water the roots, not the leaves" |\n');
  assert.ok(readFileSync(files[3], 'utf8').startsWith('# Index\n\n<!-- garden-tips -->\n'));
  assert.deepEqual(JSON.parse(readFileSync(files[5], 'utf8')),
    [{ group: 'Care', name: 'say the rule, then the reason', t: [['vidA', 65, 'water the roots, not the leaves']] }]);
  const again = run('--settings-record', join(work, 'settings.json'), '--captions', captions, '--index-file', files[3]);
  assert.equal(result(again).index, 'already holds this family');
});

test('a quote that is not in the captions writes nothing and exits 1', () => {
  const bad = structuredClone(settings);
  bad.rows[0].seen = [['vidA', 'water the leaves']];
  writeFileSync(join(work, 'bad.json'), JSON.stringify(record(bad)));
  const out = run('--settings-record', join(work, 'bad.json'), '--captions', captions, '--family-file', join(work, 'not-written.md'));
  assert.equal(out.status, 1);
  assert.equal(result(out).bad[0].reason, 'not in the captions');
  assert.equal(existsSync(join(work, 'not-written.md')), false);
});

test('a request it cannot use is refused with what to fix', () => {
  writeFileSync(join(work, 'thin.json'), JSON.stringify(record({ family: 'x' })));
  const thin = run('--settings-record', join(work, 'thin.json'), '--captions', captions);
  assert.equal(thin.status, 2);
  assert.match(result(thin).error, /lack title, introduction/);
  const noVideo = run('--settings-record', join(work, 'settings.json'), '--captions', join(work, 'captions', '*.json3'));
  assert.equal(noVideo.status, 2);
  assert.match(result(noVideo).error, /\{video\}/);
});

test('the settings row is read through tools/settings: --scope picks one of several, others are refused with what to read', () => {
  const other = { ...structuredClone(settings), family: 'other-batch', title: 'Other batch' };
  writeFileSync(join(work, 'rows.json'), JSON.stringify({ records: [record(other), record(settings)] }));
  const picked = run('--settings-record', join(work, 'rows.json'), '--scope', 'piece:garden-tips', '--captions', captions,
    '--family-file', join(work, 'picked.md'));
  assert.equal(picked.status, 0, picked.stderr);
  assert.ok(readFileSync(join(work, 'picked.md'), 'utf8').startsWith('# Garden tips\n'));
  const unscoped = run('--settings-record', join(work, 'rows.json'), '--captions', captions);
  assert.equal(unscoped.status, 2);
  assert.match(result(unscoped).error, /2 settings records were given and no scope/);
  const absent = run('--settings-record', join(work, 'rows.json'), '--scope', 'piece:no-such-batch', '--captions', captions);
  assert.equal(absent.status, 2);
  assert.match(result(absent).error, /holds no record:setting:turn-caption-quotes-into-analysis-device-rows~\.\.\. row for piece:no-such-batch/);
  writeFileSync(join(work, 'retired.json'), JSON.stringify(record(settings, { status: 'retired' })));
  assert.match(result(run('--settings-record', join(work, 'retired.json'), '--captions', captions)).error, /'retired'/);
  writeFileSync(join(work, 'foreign.json'), JSON.stringify(record(settings, { tool: 'tool:another-tool' })));
  assert.match(result(run('--settings-record', join(work, 'foreign.json'), '--captions', captions)).error, /not tool:turn-caption-quotes/);
  assert.match(result(run('--settings-record', join(work, 'nowhere.json'), '--captions', captions)).error, /does not exist/);
  assert.match(result(run('--settings-record', join(work, 'settings.json'), '--scope', 'shelf:x', '--captions', captions)).error, /not KIND:ID/);
});
