import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { takePicturesOut } from '../do-work/take-pictures-out.mjs';

const b64 = files => Buffer.from(zipSync(files)).toString('base64');
test('pictures come out as titled bytes, litter and a traversal name never become paths, and a limit refuses in words', () => {
  const out = takePicturesOut({ zip_base64: b64({ '../../x/beach.png': new Uint8Array([1, 2]), '__MACOSX/._beach.png': new Uint8Array([3]), 'notes.txt': new Uint8Array([4]) }) });
  assert.deepEqual(out.entries.map(entry => [entry.title, entry.media_type, entry.byte_count, entry.bytes_base64]), [['beach', 'image/png', 2, 'AQI=']]);
  assert.throws(() => takePicturesOut({ zip_base64: b64({ 'a.png': new Uint8Array([1]), 'b.png': new Uint8Array([2]) }), limits: { max_entries: 1 } }), /more than 1 files/);
  assert.throws(() => takePicturesOut({ zip_base64: 'bm90IGEgemlw' }), /not a readable zip archive/);
  assert.throws(() => takePicturesOut({ zip_base64: b64({ 'a.png': new Uint8Array([1]) }), profile: 'nope' }), /profile is one of chat_export/);
});
