// test/file-type.test.mjs
// A file's type is known by Trillion: a generic or missing type gives way to the type its name gives, everywhere a
// file is read, so rules that start work on a new video see a camera clip a computer labelled as "some bytes".
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceStore } from '../../recently-deleted-and-storage/namespace-store.mjs';
import { GENERIC_TYPE, fileType } from '../src/file-type.mjs';

test('a generic or missing type gives way to the type the name gives', () => {
  assert.equal(fileType(GENERIC_TYPE, '/Recordings/1TB SSD/26-10-01/C9597.MP4'), 'video/mp4');
  assert.equal(fileType(null, ['/a/no-extension', '/b/memo.m4a']), 'audio/mp4');
  assert.equal(fileType('', 'clip.mov'), 'video/quicktime');
});

test('a real type the sender gave always wins, and an unknown name keeps what was said', () => {
  assert.equal(fileType('video/quicktime', 'clip.mp4'), 'video/quicktime');
  assert.equal(fileType(GENERIC_TYPE, 'archive.unknownext'), GENERIC_TYPE);
  assert.equal(fileType(null, 'no-extension'), null);
});

test('the namespace reads a camera clip stored as some bytes as a video, without rewriting the stored row', () => {
  const host = sqliteHost(':memory:');
  const store = namespaceStore(host.sql);
  const identity = `1f:${'a'.repeat(64)}`;
  store.keepWholeFiles([{ identity, byte_length: 10, origin: 'origin:test', key: 'k', media_type: GENERIC_TYPE, name: '/Recordings/1TB SSD/26-10-01/C9547.MP4' }]);
  assert.equal(store.locate(identity).media_type, 'video/mp4');
  assert.equal(host.sql.exec('SELECT media_type FROM namespace_files WHERE identity = ?', identity).toArray()[0].media_type, GENERIC_TYPE);
});

test('stored-file catch-up pages newest first and classifies direct and alias video names', () => {
  const { sql } = sqliteHost(':memory:');
  const store = namespaceStore(sql);
  const older = `1f:${'a'.repeat(64)}`;
  const camera = `1f:${'b'.repeat(64)}`;
  const picture = `1f:${'c'.repeat(64)}`;
  const alias = `12:${'d'.repeat(64)}`;
  store.keepWholeFiles([
    { identity: older, byte_length: 10, origin: 'origin:test', key: 'older', media_type: 'video/webm', name: '/older.webm' },
    { identity: camera, byte_length: 20, origin: 'origin:test', key: 'camera', media_type: GENERIC_TYPE },
    { identity: picture, byte_length: 30, origin: 'origin:test', key: 'picture', media_type: 'image/jpeg', name: '/picture.jpg' },
  ]);
  store.addAliases(camera, [alias]);
  store.putNames([{ name: '/camera.MP4', identity: alias, byte_length: 20 }]);
  for (const [identity, storedAt] of [[older, '2026-01-01T00:00:00Z'], [camera, '2026-02-01T00:00:00Z'], [picture, '2026-03-01T00:00:00Z']]) {
    sql.exec('UPDATE namespace_files SET stored_at = ? WHERE identity = ?', storedAt, identity);
  }
  const first = store.storedFilesAfter(null, 2);
  assert.deepEqual(first.files.map(file => [file.identity, file.media_type]), [[picture, 'image/jpeg'], [camera, 'video/mp4']]);
  assert.deepEqual(first.next_after, { stored_at: '2026-02-01T00:00:00Z', identity: camera });
  const second = store.storedFilesAfter(first.next_after, 2);
  assert.deepEqual(second.files.map(file => [file.identity, file.media_type]), [[older, 'video/webm']]);
  assert.equal(second.next_after, null);
});
