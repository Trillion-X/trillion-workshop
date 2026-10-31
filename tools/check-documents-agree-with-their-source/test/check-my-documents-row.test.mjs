// tools/check-documents-agree-with-their-source: the row is the shape the engine runs on the person's computer, and the
// command, run the way the engine runs it (the granted folder in argv, the input on standard input, the answer on the
// last line), answers over a made-up folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records[0].payload;

function run(granted, input) {
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'check-my-documents.mjs'), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

function guides(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'check-my-documents-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const SET = { set_id: 'guide-translations', source: 'guide.en.md', unit_pattern: 'RFC-(\\d+)', required_markers: ['TRANSLATION STATUS'],
  mirrors: [{ document: 'guide.fr.md' }, { document: 'guide.ja.md' }] };

test('the row runs on the person\'s computer with only the folder capability, and reaches no internet', () => {
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.notEqual(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.result_selector, '$.result');
  assert.deepEqual(row.invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
});

test('a mirror that lacks the source\'s newest unit is behind; a shorter one that has it is not', t => {
  const root = guides(t, {
    'guide.en.md': 'RFC-7 RFC-42 covered in full',
    'guide.fr.md': 'RFC-42 TRANSLATION STATUS: current',
    'guide.ja.md': 'RFC-7 TRANSLATION STATUS: current',
  });
  const { status, answer } = run(root, { sets: [SET] });
  assert.equal(status, 0);
  assert.equal(answer.result.agrees, false);
  const [report] = answer.result.reports;
  assert.equal(report.set_id, 'guide-translations');
  assert.equal(report.newest_unit, 'RFC-42');
  assert.deepEqual(report.behind.map(item => item.document), ['guide.ja.md']);
  assert.deepEqual(report.missing_documents, []);
});

test('documents that all carry the newest unit and every marker agree', t => {
  const root = guides(t, {
    'guide.en.md': 'RFC-42 only',
    'guide.fr.md': 'RFC-42 TRANSLATION STATUS: current',
    'guide.ja.md': 'RFC-42 TRANSLATION STATUS: current',
  });
  assert.equal(run(root, { sets: [{ payload: SET }] }).answer.result.agrees, true);
});

test('a document that is not there is reported missing, as its own fact', t => {
  const root = guides(t, { 'guide.en.md': 'RFC-42', 'guide.fr.md': 'RFC-42 TRANSLATION STATUS: current' });
  const { answer } = run(root, { sets: [SET] });
  assert.equal(answer.result.agrees, false);
  assert.deepEqual(answer.result.reports[0].missing_documents, ['guide.ja.md']);
});

test('it refuses, in words, rather than report clean over nothing', t => {
  const root = guides(t, { 'guide.en.md': 'RFC-42' });
  assert.match(run(root, { sets: [] }).answer.error, /over no set would report clean/);
  assert.match(run(root, { sets: [{ ...SET, mirrors: [] }] }).answer.error, /mirror/);
  assert.match(run(root, { sets: [{ ...SET, source: '../outside.md' }] }).answer.error, /not a path inside the granted folder/);
  assert.match(run(join(root, 'absent'), { sets: [SET] }).answer.error, /granted folder/);
});
