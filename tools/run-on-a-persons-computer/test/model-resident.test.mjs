import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { askResident } from '../keep-drive-files.mjs';

async function resident(t, reply) {
  const folder = mkdtempSync(join(tmpdir(), 'mr-'));
  const socket = join(folder, 's');
  const sockets = new Set();
  const server = net.createServer(connection => {
    sockets.add(connection);
    connection.once('close', () => sockets.delete(connection));
    connection.once('data', () => reply(connection));
  });
  t.after(async () => {
    for (const connection of sockets) connection.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  return () => askResident({ socket, most_seconds: 1, start_seconds: 1 },
    ['must-not-start-a-model'], { argv: ['fixture'] });
}

for (const partial of ['', '{"ok":true']) {
  test(`a resident closing with ${partial ? 'partial' : 'no'} answer refuses instead of waiting forever`, { timeout: 2000 }, async t => {
    const ask = await resident(t, connection => connection.end(partial));
    await assert.rejects(ask(), /closed before its answer was complete/);
  });
}

test('a split complete resident answer survives its following close', { timeout: 2000 }, async t => {
  const ask = await resident(t, connection => {
    connection.write('{"ok":true,');
    setImmediate(() => connection.end('"value":{"text":"fixture"}}\n'));
  });
  assert.deepEqual(await ask(), { ok: true, value: { text: 'fixture' } });
});

test('a complete malformed resident answer refuses without leaving its socket open', { timeout: 2000 }, async t => {
  const ask = await resident(t, connection => connection.end('invalid\n'));
  await assert.rejects(ask(), /answered without words/);
});
