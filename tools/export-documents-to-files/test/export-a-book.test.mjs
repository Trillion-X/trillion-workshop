// tools/export-documents-to-files: the book exporter moved from the launch-video private-book-reader. Runs its Python
// tests (the exporter, the writing gate, the PDF verifier), then the entry over a made-up book, a made-up checks
// branch handed in as records and a made-up settings row.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookChecks, exportABook, settingsOfBook, TOOL_ID } from '../do-work/export-a-book.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const libraries = spawnSync('python3', ['-c', 'import docx, pypdf, pypdfium2'], { encoding: 'utf8' });
const noLibraries = libraries.status === 0 ? false : 'needs python3 with python-docx, pypdf and pypdfium2';
const settingsReader = existsSync(join(folder, '..', 'settings', 'read-data', 'settings.mjs'));

for (const suite of ['test_export_markdown_book_to_word', 'test_verify_book_against_its_source', 'test_writing_gate']) {
  test(`${suite} (Python) passes`, { skip: noLibraries, timeout: 900_000 }, () => {
    const run = spawnSync('python3', ['-m', 'unittest', suite], { cwd: join(folder, 'test'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  });
}

const branches = [
  { id: 'made-up-writing', kind: 'branch', name: 'Anything written' },
  { id: 'made-up-book', kind: 'branch', name: 'One made-up book', part_of: 'made-up-writing' },
];
const checks = [
  { id: 'no-glitter', part_of: 'made-up-writing', words: ['glitter'], says: 'No glitter.' },
  { id: 'no-zorblax', part_of: 'made-up-book', words: ['zorblax'], says: 'Never zorblax in this book.' },
];
const memoryRecords = () => [...branches, ...checks].map(value => ({ id: `record:check:${value.id}`, type: 'record:check', value }));
const book = (words) => Buffer.from(`# A made-up book\n\n## Opening\n\n${words}\n`);

test('the book\'s checks run the branch and every branch above it on the exact bytes', async () => {
  const clean = await bookChecks(memoryRecords(), { branch: 'made-up-book', bytes: book('A plain made-up passage.') });
  assert.equal(clean.status, 'passed');
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.lineage, ['made-up-book', 'made-up-writing']);
  assert.match(clean.document_blake3, /^[0-9a-f]{64}$/);
  for (const words of ['A passage with glitter.', 'A passage with zorblax.']) {
    const found = await bookChecks(memoryRecords(), { branch: 'made-up-book', bytes: book(words) });
    assert.equal(found.passed, false, words);
    assert.equal(found.status, 'failed');
  }
});

test('current prose whose checks fail is blocked before any DOCX is written', async () => {
  const work = tempFolder(join(tmpdir(), 'export-a-book-test-'));
  const manuscript = join(work, 'book.md');
  writeFileSync(manuscript, book('Some glitter here.'));
  const answer = await exportABook({ book_id: 'made-up-book', manuscript, output: join(work, 'book.docx'),
    settings: { role: 'current_prose', checks_branch: 'made-up-book', source_blake3: '0'.repeat(64) }, records: memoryRecords() });
  assert.equal(answer.status, 'blocked');
  assert.equal(answer.checks.status, 'failed');
  assert.ok(!existsSync(join(work, 'book.docx')));
  const noBranch = await exportABook({ book_id: 'made-up-book', manuscript, settings: { role: 'current_prose' } });
  assert.match(noBranch.reason, /checks_branch/);
  const noRecords = await exportABook({ book_id: 'made-up-book', manuscript, output: join(work, 'book.docx'),
    settings: { role: 'current_prose', checks_branch: 'made-up-book', source_blake3: '0'.repeat(64) } });
  assert.equal(noRecords.status, 'blocked');
  assert.match(noRecords.reason, /give them as records/);
  assert.ok(!existsSync(join(work, 'book.docx')));
});

test('a comparison copy bound by its bytes exports and reads back', { skip: noLibraries }, async () => {
  const work = tempFolder(join(tmpdir(), 'export-a-book-test-'));
  const manuscript = join(work, 'book.md');
  const bytes = book('A made-up comparison passage.\n\n| Field | Value |\n|---|---|\n| one | two |');
  writeFileSync(manuscript, bytes);
  const template = join(work, 'template.docx');
  spawnSync('python3', ['-c', `import docx; docx.Document().save(${JSON.stringify(template)})`]);
  const { makeHashCodeHexFromBytes } = await import('../../content-identity/read-data/identity.mjs');
  const settings = { role: 'comparison', source_blake3: makeHashCodeHexFromBytes(bytes).split(':')[1], template, output_folder: work };
  const answer = await exportABook({ book_id: 'made-up-book', manuscript, settings });
  assert.equal(answer.status, 'exported', answer.reason);
  assert.equal(answer.written, join(work, 'made-up-book.docx'));
  assert.equal(answer.tables, 1);
  assert.equal(answer.gate.status, 'declared_reference');
  const changed = await exportABook({ book_id: 'made-up-book', manuscript, settings: { ...settings, source_blake3: '0'.repeat(64) } });
  assert.equal(changed.status, 'blocked');
  assert.match(changed.reason, /source changed/i);
});

test('the settings come from the book\'s row the request carries, through tools/settings, and nothing is read for it', { skip: !settingsReader && 'tools/settings is not in this checkout' }, async () => {
  const { makeRecord } = await import('../../settings/read-data/settings.mjs');
  const row = makeRecord('export-documents-to-files', 'piece', 'made-up-book', { role: 'comparison' }, { name: 'made-up book', tool: TOOL_ID, source: 'made-up@0' });
  assert.deepEqual(await settingsOfBook({ book_id: 'made-up-book', settings_record: row }), { role: 'comparison' });
  await assert.rejects(settingsOfBook({ book_id: 'another-book', settings_record: row }), /is not the settings row of piece another-book/);
  await assert.rejects(settingsOfBook({ book_id: 'made-up-book', settings_record: { ...row, value: { ...row.value, status: 'retired' } } }), /retired/);
  await assert.rejects(settingsOfBook({ book_id: 'made-up-book', settings_record: row.id }), /is a row's id: give the row itself/);
  await assert.rejects(settingsOfBook({ book_id: 'made-up-book' }), /No settings row given/);
});
