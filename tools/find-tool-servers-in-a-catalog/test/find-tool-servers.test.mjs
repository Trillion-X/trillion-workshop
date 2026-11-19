// tools/find-tool-servers-in-a-catalog/do-work/find-tool-servers.mjs: a catalog read as data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findToolServers } from '../do-work/find-tool-servers.mjs';

const reply = body => async url => { reply.asked = String(url); return new Response(JSON.stringify(body), { status: 200 }); };
const entry = (server, status = 'active') => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': { status } } });

test('each server answers the address a call names, its transport and the headers it asks for; active ones first', async () => {
  const fetchImpl = reply({ servers: [
    entry({ name: 'old/mail', description: 'Old', remotes: [{ type: 'streamable-http', url: 'https://old.example/mcp' }] }, 'deprecated'),
    entry({ name: 'x/mail', title: 'Mail', description: 'Inboxes for agents', remotes: [
      { type: 'sse', url: 'https://mail.example/sse' },
      { type: 'streamable-http', url: 'https://mail.example/mcp', headers: [{ name: 'Authorization', description: 'Bearer key' }] }] }),
    entry({ name: 'local/only', description: 'Runs as a program', packages: [{ registryType: 'npm' }] }),
    entry({ name: 'plain/http', remotes: [{ type: 'streamable-http', url: 'http://insecure.example/mcp' }] }),
  ], metadata: { nextCursor: 'c2' } });
  const found = await findToolServers({ words: 'mail', limit: 5 }, { fetchImpl });
  const asked = new URL(reply.asked);
  assert.equal(asked.origin + asked.pathname, 'https://registry.modelcontextprotocol.io/v0/servers');
  assert.equal(asked.searchParams.get('search'), 'mail');
  assert.equal(asked.searchParams.get('limit'), '5');
  assert.deepEqual(found.servers.map(s => [s.name, s.status, s.address, s.transport]), [
    ['x/mail', 'active', 'https://mail.example/mcp', 'streamable-http'],
    ['local/only', 'active', null, null],
    ['plain/http', 'active', null, null],
    ['old/mail', 'deprecated', 'https://old.example/mcp', 'streamable-http'],
  ]);
  assert.deepEqual(found.servers[0].asks_for, ['Authorization']);
  assert.equal(found.servers[0].title, 'Mail');
  assert.equal(found.next_cursor, 'c2');
});

test('another catalog with the same API may be named; words, an http catalog and a bad limit are refused', async () => {
  const fetchImpl = reply({ servers: [] });
  await findToolServers({ words: 'x', catalog: 'https://catalog.example/v0/servers', cursor: 'abc' }, { fetchImpl });
  assert.equal(new URL(reply.asked).host, 'catalog.example');
  assert.equal(new URL(reply.asked).searchParams.get('cursor'), 'abc');
  await assert.rejects(findToolServers({}, { fetchImpl }), /Name the words/);
  await assert.rejects(findToolServers({ words: 'x', catalog: 'http://catalog.example' }, { fetchImpl }), /https address/);
  await assert.rejects(findToolServers({ words: 'x', limit: 500 }, { fetchImpl }), /1 to 100/);
  await assert.rejects(findToolServers({ words: 'x' }, { fetchImpl: async () => new Response('{}', { status: 200 }) }), /did not answer a list/);
});

test('several words: each is asked of the catalog and only servers holding every word in name, title or description are kept', async () => {
  const asked = [];
  const pages = {
    email: [entry({ name: 'a/email', description: 'Email inboxes for agents', remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] }),
            entry({ name: 'b/email-check', description: 'Checks addresses' })],
    inboxes: [entry({ name: 'c/inboxes', description: 'Shared inboxes' }), entry({ name: 'a/email', description: 'Email inboxes for agents' })],
  };
  const fetchImpl = async url => { const word = new URL(url).searchParams.get('search'); asked.push([word, new URL(url).searchParams.get('limit')]);
    return new Response(JSON.stringify({ servers: pages[word] ?? [] }), { status: 200 }); };
  const found = await findToolServers({ words: 'Email  INBOXES', limit: 10 }, { fetchImpl });
  assert.deepEqual(asked, [['email', '100'], ['inboxes', '100']]);
  assert.deepEqual(found.servers.map(s => s.name), ['a/email']);
  assert.equal(found.next_cursor, null);
});
