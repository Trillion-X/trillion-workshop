// A text document save is kept only while the name holds what the editor opened: identity and version must come from
// the same folder row, and a refusal keeps the draft. Runs upload.ts's saveTextVersion against the stand-in files door
// in support/ (stub-modules.mjs), with files-door.mjs and the documents and failure words real.
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import documents from './support/stub-documents.mjs';

register('./support/stub-loader.mjs', import.meta.url);
const { saveTextVersion } = await import('../../workspace-screens/web/src/workspace/upload.ts');
const stand = await import('./support/stub-modules.mjs');
const { door } = stand;
const name = '/notes/a.txt';
const listing = (identity = 'id-A', version = 4) => ({ names: [{ name, identity, version }], next_after: null });
const conflict = () => Object.assign(new Error('namespace_conflict'), { code: 'namespace_conflict', outcome: 'not_started' });
const ops = () => door.changes.map(call => call.op);

beforeEach(() => stand.reset());

test('a name changed before the save is refused in words and nothing is written', async () => {
  door.lookupAnswers = [{ identity: 'id-B' }];
  door.listing = listing('id-B', 5);
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(door.changes, []);
});

test('a new name is saved at version 0 and the answer names the identity it replaced', async () => {
  door.lookupAnswers = [null, null];
  const kept = await saveTextVersion('/notes/new.txt', 'first', null);
  assert.equal(kept.identity, 'id-new');
  assert.equal(kept.previous_identity, null);
  assert.equal(door.changes[0].op, 'write_file_start');
  assert.equal(door.changes[0].input.expected_version, 0);
});

test('an unchanged name is saved at the version the folder lists for it', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listing = listing();
  const kept = await saveTextVersion(name, 'edit', 'id-A');
  assert.deepEqual(kept, { identity: 'id-new', previous_identity: 'id-A' });
  assert.equal(door.changes[0].input.expected_version, 4);
  assert.equal(door.changes.at(-1).op, 'write_file_finish');
});

test('a write refused because someone changed the name since it was opened says so in words', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-B' }];
  door.listingAnswers = [listing(), listing('id-B', 5)];
  door.refuseStart = 'version changed';
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(ops(), ['write_file_start']);
  assert.deepEqual(door.finished, []);
});

test('a write refused while the name still holds what was opened gives the refusal itself', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-A' }];
  door.listing = listing();
  door.refuseStart = 'disk full';
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'), err => err.message === 'disk full');
  assert.deepEqual(ops(), ['write_file_start']);
});

test('a concurrent identity in the folder row cannot lend its newer version to a stale edit', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listing = listing('id-B', 5);
  await assert.rejects(saveTextVersion(name, 'stale draft', 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(door.changes, []);
});

test('a name created since a new document opened cannot be overwritten at its newer version', async () => {
  door.lookupAnswers = [null];
  door.listing = listing('id-B', 1);
  await assert.rejects(saveTextVersion(name, 'new draft', null), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(door.changes, []);
});

for (const [field, row] of [
  ['identity missing', { name, version: 4 }],
  ['identity empty', { name, identity: '', version: 4 }],
  ['version missing', { name, identity: 'id-A' }],
  ['version null', { name, identity: 'id-A', version: null }],
  ['version zero', { name, identity: 'id-A', version: 0 }],
  ['version fractional', { name, identity: 'id-A', version: 4.5 }],
  ['version unsafe', { name, identity: 'id-A', version: Number.MAX_SAFE_INTEGER + 1 }],
]) {
  test(`an existing row with ${field} fails closed without a version-0 write`, async () => {
    door.lookupAnswers = [{ identity: 'id-A' }];
    door.listing = { names: [row], next_after: null };
    await assert.rejects(saveTextVersion(name, 'edit', 'id-A'));
    assert.deepEqual(door.changes, []);
  });
}

test('the name snapshot follows pagination and uses the matching rows identity and version together', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listingAnswers = [
    { names: [{ name: '/notes/other.txt', identity: 'id-other', version: 2 }], next_after: 'page-2' },
    listing('id-A', 7),
  ];
  const kept = await saveTextVersion(name, 'edit', 'id-A');
  assert.equal(kept.identity, 'id-new');
  assert.equal(door.changes[0].input.expected_version, 7);
  assert.deepEqual(door.reads.map(call => call.args), [
    { folder: '/notes', limit: 500 },
    { folder: '/notes', limit: 500, after: 'page-2' },
  ]);
});

test('an existing name missing after the final page is changed, not a new version-0 document', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listingAnswers = [
    { names: [{ name: '/notes/other.txt', identity: 'id-other', version: 2 }], next_after: 'page-2' },
    { names: [], next_after: null },
  ];
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.equal(door.reads.length, 2);
  assert.deepEqual(door.changes, []);
});

test('a failed snapshot read is not absence and cannot start a write', async () => {
  const failure = new Error('folder read unavailable');
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listingAnswers = [failure];
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'), err => err === failure);
  assert.deepEqual(door.changes, []);
});

test('an incomplete folder page is not absence and cannot start a write', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }];
  door.listing = { next_after: null };
  await assert.rejects(saveTextVersion(name, 'edit', 'id-A'));
  assert.deepEqual(door.changes, []);
});

test('a refused finish rereads the changed name, keeps the draft and reports that it changed elsewhere', async () => {
  const draft = 'my unsaved draft';
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-B' }];
  door.listingAnswers = [listing(), listing('id-B', 5)];
  door.refuseFinish = conflict();
  await assert.rejects(saveTextVersion(name, draft, 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
  assert.equal(door.changes[0].input.expected_version, 4);
  assert.equal(Buffer.from(door.changes[1].input.content_base64, 'base64').toString(), draft);
  assert.equal(door.reads.length, 2);
  assert.deepEqual(door.finished, []);
});

test('a refused finish with the same current identity preserves its original refusal and does not retry', async () => {
  const failure = conflict();
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-A' }];
  door.listing = listing();
  door.refuseFinish = failure;
  await assert.rejects(saveTextVersion(name, 'draft', 'id-A'), err => err === failure);
  assert.deepEqual(ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
  assert.deepEqual(door.finished, []);
});

test('a refused finish with the same identity but a newer name version still reports that it changed elsewhere', async () => {
  const draft = 'my unsaved draft';
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-A' }];
  door.listingAnswers = [listing('id-A', 4), listing('id-A', 5)];
  door.refuseFinish = conflict();
  await assert.rejects(saveTextVersion(name, draft, 'id-A'), err => err.message === documents.changed_elsewhere);
  assert.deepEqual(ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
  assert.equal(door.changes[0].input.expected_version, 4);
  assert.equal(Buffer.from(door.changes[1].input.content_base64, 'base64').toString(), draft);
  assert.equal(door.reads.length, 2);
  assert.deepEqual(door.finished, []);
});

test('a read failure after a refused finish preserves that refusal rather than claiming another writer changed the name', async () => {
  const failure = conflict();
  door.lookupAnswers = [{ identity: 'id-A' }, new Error('lookup unavailable')];
  door.listingAnswers = [listing(), new Error('folder read unavailable')];
  door.refuseFinish = failure;
  await assert.rejects(saveTextVersion(name, 'draft', 'id-A'), err => err === failure);
  assert.deepEqual(ops(), ['write_file_start', 'write_file_piece', 'write_file_finish', 'write_file_cancel']);
  assert.deepEqual(door.finished, []);
});
