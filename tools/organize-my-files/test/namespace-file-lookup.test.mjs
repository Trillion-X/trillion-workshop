import assert from 'node:assert/strict';
import test from 'node:test';
import { fileTools } from '../src/file-tools.mjs';
import { fileLookupBody } from '../src/namespace-file-lookup.mjs';

const NAME = '/Private/Medical/Dad surgery.pdf', IDENTITY = '1f:' + 'a'.repeat(64);

test('a file name never travels in a request URL: the lookup and contents calls carry it in the body', async () => {
  const sent = [];
  const call = async (path, body, method) => {
    sent.push({ path, body, method });
    return { identity: IDENTITY, byte_length: 0, media_type: 'application/pdf', names: [NAME], stored: true, url: null, url_expires_at: null, encoding: 'utf-8', content: '', bytes_returned: 0 };
  };
  const find = fileTools(call).find(tool => tool.name === 'find_file');
  await find.run({ name_or_identity: NAME });
  assert.ok(sent.length > 0, 'find_file made no call');
  for (const { path, body } of sent) {
    assert.doesNotMatch(path, /Medical|Dad|surgery/, `a file name reached the URL ${path}`);
    assert.doesNotMatch(JSON.stringify(body ?? {}).replace(/"name":"[^"]*"/, ''), /Medical/, 'the name leaked outside its own field');
  }
  assert.ok(sent.some(({ path, body }) => path === '/namespace/files/lookup' && body.name === NAME));
});

test('fileLookupBody puts a path in name and an identity in identity, and never in a URL', () => {
  assert.deepEqual(fileLookupBody(NAME, { metadata: 'file' }), { name: NAME, metadata: 'file' });
  assert.deepEqual(fileLookupBody(IDENTITY), { identity: IDENTITY });
});
