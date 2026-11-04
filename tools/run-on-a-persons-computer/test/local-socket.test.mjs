// test/local-socket.test.mjs
// The opt-in local road: AI programs on this Mac run the host's tools over a Unix socket, answers are signed (F-0194).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLocal, localSocketSettings, secretOf, startLocalSocket } from '../local-socket.mjs';

const on = extra => ({ ...localSocketSettings(), enabled: true, ...extra });

test('switched off by default: nothing listens', async () => {
  assert.equal(localSocketSettings().enabled, false);
  assert.equal(await startLocalSocket({ run: async () => ({}), home: '/nonexistent' }), null);
});

test('a call runs through the host runner and comes back signed; folder and socket are the person\'s alone', async () => {
  const home = (await mkdtemp(join(tmpdir(), 'lsock-')));
  const settings = on({ path: join(home, 's/tools.sock'), secret_file: join(home, 's/secret') });
  const seen = [];
  const road = await startLocalSocket({ settings, home, run: async request => { seen.push(request); return { echoed: request.input }; } });
  try {
    assert.equal((await stat(road.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 's'))).mode & 0o777, 0o700);
    const secret = secretOf(settings, home);
    const answer = await callLocal({ path: road.path, secret }, 'tool:anything', { a: 1 }, 7);
    assert.deepEqual(answer.result, { echoed: { a: 1 } });
    assert.equal(answer.id, 7);
    await assert.rejects(callLocal({ path: road.path, secret: 'a different secret' }, 'tool:anything', {}), /not signed by this Mac host/);
    console.log('readback:', JSON.stringify({ answer, seen, socket_mode: ((await stat(road.path)).mode & 0o777).toString(8) }));
  } finally { await road.close(); }
});

test('allowed_tools narrows the road and a malformed line is answered', async () => {
  const home = (await mkdtemp(join(tmpdir(), 'lsock-')));
  const settings = on({ path: join(home, 's/tools.sock'), secret_file: join(home, 's/secret'), allowed_tools: ['tool:ok'] });
  const road = await startLocalSocket({ settings, home, run: async () => ({ fine: true }) });
  try {
    const secret = secretOf(settings, home);
    assert.deepEqual((await callLocal({ path: road.path, secret }, 'tool:ok')).result, { fine: true });
    assert.match((await callLocal({ path: road.path, secret }, 'tool:other')).error, /not one this Mac answers/);
  } finally { await road.close(); }
});
