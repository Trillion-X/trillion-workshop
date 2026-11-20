// A command reuses one kept connection: requests sent through the keeper reach the door over one connection, a command
// with no keeper goes straight and starts one, a door the keeper cannot reach fails as a fetch fails, and an address off
// this computer over plain http is never carried.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptFetch, serveKeeper, carried } from '../do-work/keep-the-connection.mjs';

const listening = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('requests through the keeper reach the door over one connection, answers and headers whole', async () => {
  let connections = 0;
  const door = http.createServer((request, reply) => {
    let body = '';
    request.on('data', part => { body += part; }).on('end', () => reply.writeHead(200, { 'content-type': 'application/json', 'x-said': 'yes' }).end(JSON.stringify({ body, auth: request.headers.authorization })));
  }).on('connection', () => { connections += 1; });
  const port = await listening(door);
  const socket = join(tempFolder(join(tmpdir(), 'kept-')), 'kept.sock');
  const keeper = serveKeeper({ socket, idleSeconds: 60, exit: () => {} });
  await new Promise(resolve => keeper.once('listening', resolve));
  const send = keptFetch({ socket, start: () => assert.fail('a keeper is there'), direct: () => assert.fail('it goes through the keeper') });
  for (const n of [1, 2, 3]) {
    const answer = await send(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer b' }, body: `call ${n}` });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('x-said'), 'yes');
    assert.deepEqual(await answer.json(), { body: `call ${n}`, auth: 'Bearer b' });
  }
  assert.equal(connections, 1);
  // The door goes away: the failure is a fetch's own (the kept connection reset, or a new one refused), which the command
  // tries again under the same request_key.
  door.closeAllConnections(); door.close();
  await assert.rejects(send(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: 'x' }), error => error instanceof TypeError && ['ECONNRESET', 'ECONNREFUSED'].includes(error.cause?.code));
  keeper.close();
});

test('with no keeper a request goes straight and one keeper is started', async () => {
  const socket = join(tempFolder(join(tmpdir(), 'kept-')), 'kept.sock');
  let started = 0;
  const send = keptFetch({ socket, start: () => { started += 1; }, direct: async () => new Response('straight') });
  assert.equal(await (await send('https://example.com/mcp', { method: 'POST', body: '{}' })).text(), 'straight');
  assert.equal(started, 1);
});

test('only https, and plain http on this computer, are carried', () => {
  assert.equal(carried(new URL('https://example.com/mcp')), true);
  assert.equal(carried(new URL('http://127.0.0.1:4100/mcp')), true);
  assert.equal(carried(new URL('http://example.com/mcp')), false);
  assert.equal(carried(new URL('file:///etc/passwd')), false);
});
