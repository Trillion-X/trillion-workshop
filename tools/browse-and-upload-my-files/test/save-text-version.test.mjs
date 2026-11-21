// A text document save is kept only at the version the editor opened: a name changed since it was opened is never
// overwritten, and the save says so in the words of documents-words.json. Runs upload.ts's saveTextVersion against the
// stand-in files door in support/ (stub-modules.mjs) with files-door.mjs real.
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import documents from './support/stub-documents.mjs';

register('./support/stub-loader.mjs', import.meta.url);
const { saveTextVersion } = await import('../../workspace-screens/web/src/workspace/upload.ts');
const stand = await import('./support/stub-modules.mjs');
const { door } = stand;

beforeEach(() => stand.reset());

test('a name changed before the save is refused in words and nothing is written', async () => {
  door.lookupAnswers = [{ identity: 'id-B' }];
  await assert.rejects(saveTextVersion('/notes/a.txt', 'edit', 'id-A'), err => err.message === documents.changed_elsewhere);
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
  door.listing = { names: [{ name: '/notes/a.txt', version: 4 }], next_after: null };
  const kept = await saveTextVersion('/notes/a.txt', 'edit', 'id-A');
  assert.deepEqual(kept, { identity: 'id-new', previous_identity: 'id-A' });
  assert.equal(door.changes[0].input.expected_version, 4);
  assert.equal(door.changes.at(-1).op, 'write_file_finish');
});

test('a write refused because someone changed the name since it was opened says so in words', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-B' }];
  door.refuseStart = 'version changed';
  await assert.rejects(saveTextVersion('/notes/a.txt', 'edit', 'id-A'), err => err.message === documents.changed_elsewhere);
});

test('a write refused while the name still holds what was opened gives the refusal itself', async () => {
  door.lookupAnswers = [{ identity: 'id-A' }, { identity: 'id-A' }];
  door.refuseStart = 'disk full';
  await assert.rejects(saveTextVersion('/notes/a.txt', 'edit', 'id-A'), err => err.message === 'disk full');
});
