// test/send-without-copies.test.mjs: the Node uploader's fetch sends a body as it is and answers like fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithoutCopies } from '../do-work/send-without-copies.mjs';

test('a body goes to the server byte for byte from a view of a larger buffer, and the answer reads like fetch', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const parts = [];
    request.on('data', part => parts.push(part));
    request.on('end', () => {
      seen.push({ method: request.method, length: request.headers['content-length'], body: Buffer.concat(parts), auth: request.headers.authorization });
      response.writeHead(request.method === 'DELETE' ? 204 : 201, { 'content-type': 'application/json', 'x-two': ['a', 'b'] });
      response.end(request.method === 'DELETE' ? undefined : JSON.stringify({ got: Buffer.concat(parts).length }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const whole = Uint8Array.from({ length: 64 }, (_, index) => index);
    const view = whole.subarray(10, 42);
    const answer = await fetchWithoutCopies(`${origin}/put`, { method: 'PUT', headers: { authorization: 'Bearer x' }, body: view });
    assert.equal(answer.status, 201);
    assert.equal(answer.ok, true);
    assert.deepEqual(await answer.json(), { got: 32 });
    assert.equal(answer.headers.get('x-two'), 'a, b');
    assert.deepEqual([...seen[0].body], [...view]);
    assert.equal(seen[0].length, '32');
    assert.equal(seen[0].auth, 'Bearer x');
    assert.equal((await fetchWithoutCopies(`${origin}/text`, { method: 'POST', body: 'hello' })).status, 201);
    assert.equal(seen[1].body.toString(), 'hello');
    const none = await fetchWithoutCopies(`${origin}/gone`, { method: 'DELETE' });
    assert.equal(none.status, 204);
    assert.equal(await none.text(), '');
    await assert.rejects(fetchWithoutCopies(`${origin}/x`, { method: 'POST', body: { not: 'bytes' } }), /Uint8Array or a string/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
