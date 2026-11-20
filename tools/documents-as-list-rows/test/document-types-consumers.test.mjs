// The public documents owner used by list document-types and plain-file consumers.
// Synthetic files only: preserve unrelated sidecar metadata and refuse stale conditional writes.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DocumentPropertiesError, documentsFolderOf, readDocumentTypes, readSidecar, saveDocumentTypes } from '../read-data/document-properties.mjs';
import { folderFiles } from '../read-data/folder-files.mjs';

test('a list selects only its declared documents source and retains missing-list refusals', () => {
  assert.equal(documentsFolderOf({ id: 'notes', row_sources: [{ source: 'other', of: '/private' }, { source: 'documents', of: 'notes///' }] }), '/notes');
  assert.equal(documentsFolderOf({ row_sources: [{ source: 'documents' }] }), '/');
  assert.throws(() => documentsFolderOf(null, 'missing'), error => error instanceof DocumentPropertiesError && error.code === 'no_list' && error.status === 400 && error.detail.list_id === 'missing' && error.message.includes('missing'));
  assert.throws(() => documentsFolderOf({ id: 'tasks', row_sources: [{ source: 'other', of: '/private' }] }), error => error.code === 'not_documents' && error.status === 400 && error.message.includes('tasks'));
});

test('sidecar reads and conditional type writes preserve other owners metadata and reject a stale identity', async t => {
  const root = tempFolder(join(tmpdir(), 'document-types-consumers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await folderFiles(root);
  assert.equal(await readSidecar(files, '/'), null);
  assert.deepEqual((await readDocumentTypes(files, '/')).types, {});
  await writeFile(join(root, 'property-types.json'), JSON.stringify({ list: { id: 'notes', title: 'Keep this list' }, extra: ['keep'], types: { status: 'text' }, formulas: {} }));
  const before = await readDocumentTypes(files, '/');
  const saved = await saveDocumentTypes(files, '/', { types: { rating: 'number' }, formulas: {}, expected_identity: before.identity });
  assert.deepEqual(saved.types, { rating: 'number' });
  assert.deepEqual((await readSidecar(files, '/')).list, { id: 'notes', title: 'Keep this list' });
  assert.deepEqual((await readSidecar(files, '/')).extra, ['keep']);
  const unchanged = await readFile(join(root, 'property-types.json'), 'utf8');
  await assert.rejects(saveDocumentTypes(files, '/', { types: {}, expected_identity: before.identity }), error => error.code === 'document_changed');
  assert.equal(await readFile(join(root, 'property-types.json'), 'utf8'), unchanged);
  await saveDocumentTypes(files, '/', { types: {}, formulas: {}, expected_identity: saved.identity });
  assert.deepEqual((await readDocumentTypes(files, '/')).types, {});
  assert.deepEqual((await readSidecar(files, '/')).extra, ['keep']);
});

test('the permissive metadata read never turns malformed types into a successful types read', async t => {
  const root = tempFolder(join(tmpdir(), 'document-types-malformed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await folderFiles(root);
  await writeFile(join(root, 'property-types.json'), '{broken');
  assert.equal(await readSidecar(files, '/'), null);
  await assert.rejects(readDocumentTypes(files, '/'), error => error.code === 'bad_document_types');
});
