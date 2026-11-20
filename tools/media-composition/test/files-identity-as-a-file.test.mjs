// tools/media-composition/test/files-identity-as-a-file.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { withFilesIdentityAsFile } from '../read-data/files-identity-as-a-file.mjs';

/** A host whose files('read_file') serves `bytes` in pages of `page` bytes, as the Files session does. */
const hostServing = (bytes, { page = 4, encoding = 'base64' } = {}) => ({
  calls: [],
  async files(method, input) {
    this.calls.push([method, input.offset, input.length]);
    const slice = bytes.subarray(input.offset, input.offset + Math.min(input.length, page));
    return {
      byte_length: bytes.length,
      bytes_returned: slice.length,
      encoding,
      content: encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8'),
    };
  },
});

test('the file is written from pages, 0600, and read by the program from its path', async () => {
  const bytes = Buffer.from('0123456789abcdefghij');
  const host = hostServing(bytes, { page: 6 });
  const seen = await withFilesIdentityAsFile(host, '1f:aa', file => {
    assert.equal(readFileSync(file).equals(bytes), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    return file;
  }, { readBytes: 6 });
  assert.deepEqual(host.calls.map(call => call[1]), [0, 6, 12, 18]);
  assert.equal(existsSync(seen), false, 'the folder is removed after the program');
});

test('a utf8 page is written as its own text', async () => {
  const bytes = Buffer.from('plain text');
  await withFilesIdentityAsFile(hostServing(bytes, { page: 4, encoding: 'utf8' }), '1f:bb', file => {
    assert.equal(readFileSync(file, 'utf8'), 'plain text');
  }, { readBytes: 4 });
});

test('a file above the most bytes is refused before its first page is written', async () => {
  const host = hostServing(Buffer.alloc(100));
  await assert.rejects(
    withFilesIdentityAsFile(host, '1f:cc', () => assert.fail('the program must not run'), { mostBytes: 10, readBytes: 4 }),
    error => error.code === 'file_too_large',
  );
});

test('the folder is removed when the program fails', async () => {
  const host = hostServing(Buffer.from('abc'));
  let kept = null;
  await assert.rejects(withFilesIdentityAsFile(host, '1f:dd', file => { kept = file; throw new Error('ffmpeg failed'); }), /ffmpeg failed/);
  assert.equal(existsSync(kept), false);
});
