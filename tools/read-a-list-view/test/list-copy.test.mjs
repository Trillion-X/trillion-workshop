// A list that is the original and a folder that is its copy (read-data/list-copy.mjs), on a made-up bakery's notes in a real
// folder: a folder never read reaches the list, a list edit reaches the file, a file edit reaches the list, a change on both
// sides keeps both (the later one wins), a removal on either side reaches the other, a restore never becomes a removal,
// an AI's row becomes a file, a dry run writes nothing, and a sync not handed its history refuses to judge.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncStore } from './support/sync-store.mjs';

const TYPE = 'record:note';
const recordOf = name => `${TYPE}:notes~${encodeURIComponent(`/${name}`)}`;
const NOTE = (name, description, body = `${description}\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

async function bakery(files = {}) {
  const root = tempFolder(join(tmpdir(), 'list-copy-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  const source = { id: 'notes', source: 'documents', of: '/', root, original: 'list', adopt_own_rows: true, copy_name: '{note.name}.md',
    content: { field: 'document.text', part_bytes: 4000 } };
  const store = syncStore([['list:notes', 'list', { label: 'Notes', row_type: 'note', row_sources: [source] }]]);
  const row = name => store.records().find(record => record.id === recordOf(name))?.value;
  const file = name => readFile(join(root, name), 'utf8');
  const sync = input => store.sync({ list: 'notes', ...input }).then(answer => answer.sources[0]);
  return { root, store, row, file, sync, done: () => rm(root, { recursive: true, force: true }) };
}

test('a folder that has never been read reaches the list, and a second sync changes nothing', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    const first = await b.sync();
    assert.equal(first.pushed, 1);
    assert.equal(b.row('rye.md')['note.description'], 'Rye loaf.');
    const again = await b.sync();
    assert.equal(again.unchanged, 1);
    assert.equal(again.pushed, 0);
  } finally { await b.done(); }
});

test('a list edit of a frontmatter value goes into the file, and the file keeps its text', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    await b.sync();
    b.store.tick();
    b.store.write(recordOf('rye.md'), TYPE, { ...b.row('rye.md'), 'note.description': 'Dark rye loaf.' });
    const report = await b.sync();
    assert.equal(report.pulled, 1);
    assert.match(await b.file('rye.md'), /description: Dark rye loaf\./);
    assert.match(await b.file('rye.md'), /\nRye loaf\.\n$/);
  } finally { await b.done(); }
});

test('a file edit reaches the list', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    await b.sync();
    b.store.tick();
    await writeFile(join(b.root, 'rye.md'), NOTE('rye', 'Rye loaf, sliced.', 'Slice it.\n'));
    const report = await b.sync();
    assert.equal(report.pushed, 1);
    assert.match(b.row('rye.md')['document.text'], /Slice it\./);
  } finally { await b.done(); }
});

test('a change on both sides keeps both: the later change wins and the other is named as a conflict', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    await b.sync();
    b.store.tick();
    b.store.write(recordOf('rye.md'), TYPE, { ...b.row('rye.md'), 'document.text': 'From the list.\n' });
    await writeFile(join(b.root, 'rye.md'), NOTE('rye', 'Rye loaf.', 'From the file.\n'));
    const report = await b.sync();
    assert.equal(report.conflicts.length, 1);
    assert.equal(report.conflicts[0].kept, 'file');
    assert.match(await b.file('rye.md'), /From the file\./);
  } finally { await b.done(); }
});

test('a removal on the list removes the file, and a removal of the file removes its rows', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.'), 'buns.md': NOTE('buns', 'Buns.') });
  try {
    await b.sync();
    b.store.tick();
    b.store.write(recordOf('rye.md'), TYPE, null);
    const removed = await b.sync();
    assert.equal(removed.removed_files, 1);
    await assert.rejects(readFile(join(b.root, 'rye.md')));
    const { unlink } = await import('node:fs/promises');
    await unlink(join(b.root, 'buns.md'));
    b.store.tick();
    const gone = await b.sync();
    assert.equal(gone.removed_rows, 1);
    assert.equal(b.row('buns.md'), undefined);
  } finally { await b.done(); }
});

test('a restore from an older copy never removes: a removal older than the restore is carried back up to the list', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    await b.sync();
    b.store.write(recordOf('rye.md'), TYPE, null);
    const restore = { value: { generation: 2, restored_at: '2026-06-01T00:00:00Z' } };
    const report = await b.sync({ restore });
    assert.equal(report.carried_after_restore, 1);
    assert.equal(report.removed_files, 0);
    assert.equal(b.row('rye.md')['note.description'], 'Rye loaf.');
  } finally { await b.done(); }
});

test('an AI row written under its own id becomes a file named from its values, then one row', async () => {
  const b = await bakery();
  try {
    await b.sync();
    b.store.tick();
    b.store.write(`${TYPE}:from-a-phone`, TYPE, { 'note.name': 'sourdough', 'note.description': 'Sourdough.', 'document.text': 'Feed it daily.\n' });
    const report = await b.sync();
    assert.equal(report.adopted, 1);
    assert.match(await b.file('sourdough.md'), /description: Sourdough\./);
    assert.equal(b.store.records().some(record => record.id === `${TYPE}:from-a-phone`), false);
    assert.match(b.row('sourdough.md')['document.text'], /Feed it daily\./);
  } finally { await b.done(); }
});

test('a dry run plans what it would do and writes nothing', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    const planned = await b.sync({ dry_run: true });
    assert.deepEqual(planned.planned, [{ action: 'push', document: '/rye.md' }]);
    assert.equal(b.store.records().length, 1);
    assert.equal(b.row('rye.md'), undefined);
  } finally { await b.done(); }
});

test('a two-way sync not handed its history or its restore record refuses to judge anything', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.') });
  try {
    const { refreshRowSources } = await import('../read-data/list-view.mjs');
    const { NAMES } = await import('./support/stored.mjs');
    const stored = b.store.stored();
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'notes', stored: { records: stored.records, restore: null } }), error => error.code === 'bad_input');
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'notes', stored: { records: stored.records, history: {} } }), error => error.code === 'bad_input');
  } finally { await b.done(); }
});

test('a paths run settles only the named document', async () => {
  const b = await bakery({ 'rye.md': NOTE('rye', 'Rye loaf.'), 'buns.md': NOTE('buns', 'Buns.') });
  try {
    const answer = await b.sync({ paths: ['/rye.md'] });
    assert.equal(answer.documents, 1);
    assert.equal(b.row('buns.md'), undefined);
    assert.equal(b.row('rye.md')['note.description'], 'Rye loaf.');
  } finally { await b.done(); }
});
