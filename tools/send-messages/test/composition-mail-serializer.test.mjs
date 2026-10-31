// tools/send-messages/test/composition-mail-serializer.test.mjs
//
// Runs the document-to-message-body tests (test_composition_mail_serializer.py: its own cases from the package, each
// a test_ function in one program) and then the command as the row runs it, on a small written document. Needs
// python3 (standard library only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const folder = fileURLToPath(new URL('..', import.meta.url));
const python = (...argv) => spawnSync('python3', ['-I', ...argv], { encoding: 'utf8' });
const skip = python('--version').status === 0 ? false : 'needs python3';

test('test_composition_mail_serializer.py passes', { skip }, () => {
  const run = python(join(folder, 'test', 'test_composition_mail_serializer.py'));
  assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  assert.match(run.stdout, /all composition-mail-serializer tests passed/);
});

test('the command turns a request file into a result file', { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), 'serializer-'));
  const request = join(work, 'request.json');
  const output = join(work, 'out.json');
  writeFileSync(request, JSON.stringify({ document_nodes: [
    { id: 'h', kind: 'Heading1', props: { text: 'Update' } },
    { id: 'p', kind: 'Text', props: { text: 'Hello <world>' } },
    { id: 'q', kind: 'Text', props: { text: 'their words', quote: true } },
  ] }));
  const run = python(join(folder, 'do-work', 'composition_mail_serializer.py'), request, output);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.body_html, '<h1>Update</h1><p>Hello &lt;world&gt;</p><blockquote><p>their words</p></blockquote>');
  assert.equal(result.body_text, 'Update\nHello <world>\n> their words');
  assert.deepEqual(result.degraded, []);
});

test('the command with too few arguments says how to use it and exits 2', { skip }, () => {
  const run = python(join(folder, 'do-work', 'composition_mail_serializer.py'));
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage:/);
});
