// Zip archives hand an importer bytes, never paths (src/archive-entries.mjs, limits in src/archive-entries.json).
import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { archiveEntries, ArchiveRefused } from '../src/archive-entries.mjs';

const bytes = text => new TextEncoder().encode(text);

test('only picture entries come out, as bytes with a title; litter and traversal names carry no path', () => {
  const zip = zipSync({
    'holiday/beach.PNG': bytes('png-bytes'), '../../etc/evil.jpg': bytes('jpg-bytes'), '/abs/root.gif': bytes('gif-bytes'),
    '__MACOSX/holiday/._beach.png': bytes('x'), 'holiday/.DS_Store': bytes('x'), 'holiday/notes.txt': bytes('words'), 'holiday/._hidden.png': bytes('x'),
  });
  const entries = archiveEntries(zip);
  assert.deepEqual(entries.map(entry => [entry.title, entry.media_type, new TextDecoder().decode(entry.bytes)]), [
    ['beach', 'image/png', 'png-bytes'], ['evil', 'image/jpeg', 'jpg-bytes'], ['root', 'image/gif', 'gif-bytes'],
  ]);
  assert.ok(entries.every(entry => !('name' in entry) && !('path' in entry)));
});

test('limits stop the archive with the reason, and a non-zip is refused', () => {
  const zip = zipSync({ 'a.png': bytes('aaaa'), 'b.png': bytes('bbbb'), 'c.png': bytes('cccc') });
  assert.throws(() => archiveEntries(zip, { max_entries: 2, max_entry_bytes: 100, max_total_bytes: 100, max_ratio: 200 }), ArchiveRefused);
  assert.throws(() => archiveEntries(zip, { max_entries: 5, max_entry_bytes: 3, max_total_bytes: 100, max_ratio: 200 }), /larger than 3 bytes/);
  assert.throws(() => archiveEntries(zipSync({ 'z.png': new Uint8Array(100000) }), { max_entries: 5, max_entry_bytes: 1e6, max_total_bytes: 1e7, max_ratio: 50 }), /expands too far/);
  assert.throws(() => archiveEntries(bytes('not a zip')), /not a readable zip/);
});
