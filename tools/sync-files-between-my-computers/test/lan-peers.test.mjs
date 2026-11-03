// LAN peers (do-work/lan-peers.mjs). Moved from old trillion test/files-sync-adoption.test.mjs: the announcement test
// one to one; the two that ran through the old Drive keep their assertions, with the Drive's peer server replaced by
// a stand-in server here that holds one file and answers with the module's own verify. Every address is loopback or a
// documentation range; every key and computer id is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dgram, { createSocket } from 'node:dgram';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createPeers } from '../do-work/lan-peers.mjs';
import { settingsOf } from '../do-work/drive-sync-status.mjs';

const identityOf = bytes => `1f:${bytesToHex(blake3(bytes))}`;
const text = value => Buffer.from(value);

// The old Drive's peer answer (computer/trillion-drive.mjs peerAnswer): 403 unless verify passes, 404 unless held whole.
async function holderServing({ secret, selfId, files }) {
  const table = createPeers({ config: { ...settingsOf().peers, known: [] }, secret, selfId });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://peer');
    const named = url.pathname.match(/^\/peer\/file\/(1f:[0-9a-f]{64})$/);
    if (!named) { response.writeHead(404); return response.end(); }
    const refusal = table.verify('GET', `${url.pathname}${url.search}`, request.headers);
    if (refusal) { response.writeHead(403); return response.end(refusal); }
    const held = files.get(named[1]);
    if (!held || Number(url.searchParams.get('length')) !== held.length) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'content-length': held.length });
    response.end(held);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { table, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => new Promise(done => server.close(done)) };
}

test('a computer of the same account fills a file from a peer that holds it whole, checked against its BLAKE3 identity, and gets nothing from a wrong key, a damaged copy or when no peer is known', async () => {
  const body = Buffer.from('peer bytes, '.repeat(500));
  const identity = identityOf(body);
  const files = new Map([[identity, body]]);
  const holder = await holderServing({ secret: 'k', selfId: 'mac-a', files });
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-peer-'));
  try {
    const config = { ...settingsOf().peers, known: [holder.url] };
    const good = createPeers({ config, secret: 'k', selfId: 'mac-b' });
    const dest = path.join(dir, 'good.part');
    assert.equal(await good.fetchWhole({ identity, length: body.length, dest }), holder.url);
    assert.deepEqual(readFileSync(dest), body, 'every byte came from the peer');
    const none = createPeers({ config: { ...config, known: [] }, secret: 'k', selfId: 'mac-b' });
    assert.equal(await none.fetchWhole({ identity, length: body.length, dest: path.join(dir, 'none.part') }), null, 'with no peer the bytes come from Trillion');
    const stranger = createPeers({ config, secret: 'another-account-key', selfId: 'mac-b' });
    const strangerDest = path.join(dir, 'stranger.part');
    assert.equal(await stranger.fetchWhole({ identity, length: body.length, dest: strangerDest }), null, 'another account\'s key is refused by the peer');
    assert.equal(existsSync(strangerDest), false, 'nothing refused is left on disk');
    assert.deepEqual(stranger.live(), [], 'a peer that refused is put on its cooldown');
    // Damage the held copy: the asker rejects the bytes by identity.
    files.set(identity, Buffer.concat([body.subarray(0, 1024), Buffer.alloc(1024, 7), body.subarray(2048)]));
    const bad = createPeers({ config, secret: 'k', selfId: 'mac-b' });
    const badDest = path.join(dir, 'bad.part');
    assert.equal(await bad.fetchWhole({ identity, length: body.length, dest: badDest }), null, 'the right bytes or none, never the damaged ones');
    assert.equal(existsSync(badDest), false);
    assert.deepEqual(bad.live(), [], 'a peer that sent other bytes is cooled');
    assert.equal(await good.fetchWhole({ identity: 'not-an-identity', length: 1, dest }), null, 'a file not named whole is not asked for');
  } finally { await holder.close(); }
});

test('a peer request must be signed by this account, in its time window, from another computer, and for a file the requester names whole', async () => {
  const holder = await holderServing({ secret: 'k', selfId: 'mac-c', files: new Map() });
  try {
    const config = { ...settingsOf().peers, known: [] };
    const sibling = createPeers({ config, secret: 'k', selfId: 'mac-d' });
    const foreign = createPeers({ config, secret: 'not-k', selfId: 'mac-d' });
    const same = createPeers({ config, secret: 'k', selfId: 'mac-c' });
    const target = `/peer/file/${identityOf(text('x'))}?length=1`;
    const ask = headers => fetch(`http://127.0.0.1:${holder.port}${target}`, { headers });
    assert.equal((await ask(sibling.signed('GET', target))).status, 404, 'a signed request for a file not held is not found');
    assert.equal((await ask(foreign.signed('GET', target))).status, 403, 'another account key is refused');
    assert.equal((await ask(same.signed('GET', target))).status, 403, 'this computer\'s own identity is refused');
    assert.equal((await ask({})).status, 403, 'an unsigned request is refused');
    const late = createPeers({ config, secret: 'k', selfId: 'mac-d', now: () => Date.now() - 3600_000 });
    assert.equal((await ask(late.signed('GET', target))).status, 403, 'a request outside its window is refused');
    assert.equal((await ask(sibling.signed('GET', `${target}0`))).status, 403, 'a signature does not carry to another target');
    assert.equal(holder.table.verify('GET', target, {}), 'The request is outside its time window.');
  } finally { await holder.close(); }
});

test('Drives announce themselves by UDP, hear only announcements signed by their account, and add the sender as a peer', async () => {
  const free = await new Promise(resolve => { const s = dgram.createSocket('udp4'); s.bind(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
  const config = settings => ({ ...settingsOf().peers, announce: { ...settingsOf().peers.announce, enabled: true, to: ['127.0.0.1'], port: free, every_seconds: 1, ttl_seconds: 30 }, ...settings });
  const listener = createPeers({ config: config(), secret: 'k', selfId: 'mac-1' });
  const hearing = listener.announce('');
  await hearing.ready;
  try {
    const stranger = createPeers({ config: config(), secret: 'other', selfId: 'mac-9' });
    assert.equal(listener.heard(stranger.announcement('http://10.0.0.9:7385')), false, 'another account is not heard');
    assert.equal(listener.heard(listener.announcement('http://10.0.0.1:7385')), false, 'its own announcement is not a peer');
    const sibling = createPeers({ config: config(), secret: 'k', selfId: 'mac-2' });
    assert.equal(listener.heard(sibling.announcement('http://10.0.0.2:7385')), true);
    assert.deepEqual(listener.live(), ['http://10.0.0.2:7385']);
    const sender = createSocket('udp4');
    await new Promise(resolve => sender.send(sibling.announcement('http://10.0.0.3:7385'), free, '127.0.0.1', resolve));
    await new Promise(resolve => setTimeout(resolve, 150));
    sender.close();
    assert.deepEqual(listener.live().sort(), ['http://10.0.0.2:7385', 'http://10.0.0.3:7385']);
  } finally { hearing.stop(); }
});

test('peers are off and announce to the LAN broadcast port by DATA, never by code', () => {
  const peers = settingsOf().peers;
  assert.equal(peers.enabled, false);
  assert.equal(peers.announce.enabled, false);
  assert.deepEqual([peers.announce.port, peers.announce.to], [17500, ['255.255.255.255']]);
});
