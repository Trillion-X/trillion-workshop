// How a file's words are read (wayOf), over the DATA rows in read-data/file-words.json. The cases are the branches of the
// older Workshop copy's wayOf (commit b6ae0ebf81); that code had no test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wayOf } from '../do-work/way-of-a-file.mjs';

test('a named type is read by its row, parameters and case ignored', () => {
  assert.equal(wayOf({ media_type: 'Application/PDF; charset=binary', name: 'deck.bin' }), 'converted');
  assert.equal(wayOf({ media_type: 'text/plain; charset=utf-8', name: 'a.txt' }), 'as-text');
  assert.equal(wayOf({ media_type: 'application/vnd.ms-excel', name: 'sheet.xls' }), 'converted');
});

test('a named type that no row reads is not read, even when its name ends in a readable extension', () => {
  assert.equal(wayOf({ media_type: 'image/png', name: 'photo.pdf' }), null);
});

test('a type that names nothing is read by its extension, in any case, and by no extension at all when none matches', () => {
  assert.equal(wayOf({ media_type: 'application/octet-stream', name: 'Notes.MD' }), 'as-text');
  assert.equal(wayOf({ media_type: '', name: 'scan.pdf' }), 'converted');
  assert.equal(wayOf({ media_type: 'binary/octet-stream', name: 'photo.jpg' }), null);
  assert.equal(wayOf({ media_type: '', name: 'readme' }), null);
});

test('an extension is read from the file name only, never from a dot in a folder name', () => {
  assert.equal(wayOf({ media_type: '', name: 'folder.v2/readme' }), null);
  assert.equal(wayOf({ media_type: '', name: 'folder.v2/readme.txt' }), 'as-text');
});
