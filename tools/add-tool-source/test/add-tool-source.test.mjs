// tools/add-tool-source/test/add-tool-source.test.mjs
//
// The tool that adds a source of tools from one address, over a stand-in records door (tools/records-door/test/fake-door.mjs) that
// holds exactly the rights the row declares and a stand-in web whose servers answer as an MCP server, as a git repository, as both
// or as neither. Every address, host, commit and label is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { addToolSource } from '../do-work/add-tool-source.mjs';
import data from '../read-data/add-tool-source.json' with { type: 'json' };
import rows from '../tool-rows.json' with { type: 'json' };

const row = rows.records.find(entry => entry.payload.id === 'tool:add-tool-source').payload;
const COMMIT = 'a'.repeat(40);
const ADVERT = `001e# service=git-upload-pack\n0000${'0'.repeat(4)}${COMMIT} HEAD\0multi_ack side-band-64k\n`;
const initialize = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'made-up', version: '1' } } };

/** A web of made-up servers: `as` names how each address answers. */
function web(as) {
  const asked = [];
  const send = async (address, init = {}) => {
    asked.push({ address: String(address), init });
    const url = new URL(address);
    const server = as[url.hostname] ?? {};
    if (init.method === 'POST') {
      if (server.mcp === 'json') return new Response(JSON.stringify(initialize), { status: 200, headers: { 'content-type': 'application/json' } });
      if (server.mcp === 'stream') return new Response(`event: message\ndata: ${JSON.stringify(initialize)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (server.mcp === 'sign-in') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://made-up.example/.well-known/oauth-protected-resource"' } });
      if (server.redirect) return new Response(null, { status: 307, headers: { location: server.redirect } });
      return new Response('nope', { status: 404 });
    }
    if (server.git && url.pathname.endsWith('/info/refs')) return new Response(ADVERT, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    if (server.hang) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return new Response('<html>a page</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return { send, asked };
}

async function open(records = []) {
  const door = await startFakeDoor({ rights: row.invoke.records.rights, records });
  return { door, records_door: openRecordsDoor({ descriptor: door.descriptor }) };
}

const add = (records_door, input, as = {}) => addToolSource(input, { door: records_door, fetch: web(as).send });

test('a path, a prefix and a listed git host are known by their syntax and nothing is asked of the web', async () => {
  const { door, records_door } = await open();
  try {
    const being = web({ 'github.com': { git: true } });
    const folder = await addToolSource({ address: '/opt/example-tools/my-tools' }, { door: records_door, fetch: being.send });
    assert.deepEqual(folder.entry, { label: 'my-tools', kind: 'folder', place: { at: '/opt/example-tools/my-tools' } });
    assert.equal(folder.source.learned, 'syntax');
    assert.equal((await addToolSource({ address: '~/Tools/set', label: 'set-one' }, { door: records_door, fetch: being.send })).entry.place.home, 'Tools/set');
    assert.deepEqual((await addToolSource({ address: 'file:///opt/shared-tools/' }, { door: records_door, fetch: being.send })).entry.place, { at: '/opt/shared-tools' });
    const server = await addToolSource({ address: 'mcp+https://tools.made-up.example/mcp' }, { door: records_door, fetch: being.send });
    assert.deepEqual(server.entry, { label: 'tools.made-up.example', kind: 'remote-mcp', remote: { url: 'https://tools.made-up.example/mcp' } });
    const own = await addToolSource({ address: 'mcp+http://127.0.0.1:8123/mcp', label: 'mine' }, { door: records_door, fetch: being.send });
    assert.deepEqual(own.entry.remote, { url: 'http://127.0.0.1:8123/mcp', private_targets: [{ host: '127.0.0.1', port: 8123 }] });
    assert.deepEqual(being.asked, [], 'a syntax that says what it is asks the web nothing');
  } finally { await door.close(); }
});

test('a repository is a repository at any listed host, nested groups included, and starts at the commit its server names now', async () => {
  const { door, records_door } = await open();
  try {
    const hosts = { 'github.com': { git: true }, 'gitlab.com': { git: true } };
    const github = await add(records_door, { address: 'https://github.com/made-up/set' }, hosts);
    assert.deepEqual(github.entry, { label: 'set', kind: 'repo', repository: 'made-up/set', first_start_commit: COMMIT, archive: data.repo_hosts['github.com'].archive, source_hosts: ['codeload.github.com'] });
    assert.deepEqual(github.approve, { address: '@tools', method: 'tools:add-source', input: { entry: github.entry, learned: 'syntax' } });
    const gitlab = await add(records_door, { address: 'git+https://gitlab.com/group/sub/tools.git' }, hosts);
    assert.equal(gitlab.entry.repository, 'group/sub/tools');
    assert.equal(gitlab.entry.archive, data.repo_hosts['gitlab.com'].archive);
    await assert.rejects(add(records_door, { address: 'https://github.com/only-owner' }, hosts), /names no repository/);
    await assert.rejects(add(records_door, { address: 'https://github.com/made-up/empty', label: 'empty' }, { 'github.com': {} }), /did not answer as an MCP server/);
    await assert.rejects(add(records_door, { address: 'git+https://git.made-up.example/o/r' }, { 'git.made-up.example': { git: true } }), /do not know where it serves a commit's archive/);
  } finally { await door.close(); }
});

test('a bare https address is looked at once: an MCP server by initialize or by asking for sign-in, a git repository by its refs', async () => {
  const { door, records_door } = await open();
  try {
    const answers = { 'a.made-up.example': { mcp: 'json' }, 'b.made-up.example': { mcp: 'stream' }, 'c.made-up.example': { mcp: 'sign-in' } };
    for (const host of Object.keys(answers)) {
      const added = await add(records_door, { address: `https://${host}/mcp` }, answers);
      assert.deepEqual([added.entry.kind, added.source.learned], ['remote-mcp', 'probe'], host);
      assert.equal(added.entry.remote.url, `https://${host}/mcp`);
    }
    const being = web({ 'git.made-up.example': { git: true } });
    await assert.rejects(addToolSource({ address: 'https://git.made-up.example/o/r' }, { door: records_door, fetch: being.send }), /do not know where it serves/);
    assert.ok(being.asked.every(sent => !sent.init.headers?.authorization && sent.init.credentials === 'omit' && sent.init.redirect === 'manual'), 'nothing is sent with a credential, and no redirect is followed blind');
  } finally { await door.close(); }
});

test('an address that is neither, both, a private one, one that hangs or one that holds a password is refused in one plain line', async () => {
  const { door, records_door } = await open();
  try {
    const refuses = async (input, as, words) => assert.rejects(add(records_door, input, as), error => words.test(error.message) && !error.message.includes('\n'));
    await refuses({ address: 'https://page.made-up.example/' }, { 'page.made-up.example': {} }, /did not answer as an MCP server \(it answered 404\) or as a git repository \(its answer was not a ref advertisement\)\. .*mcp\+https:\/\/page\.made-up\.example\/ or git\+/);
    await refuses({ address: 'https://both.made-up.example/x' }, { 'both.made-up.example': { mcp: 'json', git: true } }, /answers as an MCP server and as a git repository\. Say which it is/);
    await refuses({ address: 'https://slow.made-up.example/' }, { 'slow.made-up.example': { hang: true } }, /did not answer in time/);
    await refuses({ address: 'https://10.0.0.5/mcp' }, { '10.0.0.5': {} }, /mcp\+http:\/\/host:port/);
    await refuses({ address: 'http://127.0.0.1:9/mcp' }, {}, /write it as mcp\+http:\/\/host:port\/path/);
    await refuses({ address: 'git@example.com:o/r.git' }, {}, /ssh or git@/);
    await refuses({ address: ['https://user:secret', 'made-up.example/mcp'].join('@') }, {}, /user name or password/);
    await refuses({ address: '../tools' }, {}, /not an address/);
    await refuses({ address: '/tmp/../etc' }, {}, /not an address/);
    await refuses({ address: '' }, {}, /Give the address/);
    await refuses({ address: '/tmp/x', label: '.hidden' }, {}, /A label is letters/);
    assert.equal(door.kept.size, 0, 'a refusal keeps no row');
  } finally { await door.close(); }
});

test('a redirect is followed only to https and only so far', async () => {
  const { door, records_door } = await open();
  try {
    await assert.rejects(add(records_door, { address: 'https://moved.made-up.example/' }, { 'moved.made-up.example': { redirect: 'http://elsewhere.made-up.example/' } }), /not https/);
    await assert.rejects(add(records_door, { address: 'https://loop.made-up.example/' }, { 'loop.made-up.example': { redirect: 'https://loop.made-up.example/' } }), /too many redirects/);
  } finally { await door.close(); }
});

test('the source is kept as one row waiting for the person, once, and the row can touch nothing else', async () => {
  const { door, records_door } = await open();
  try {
    const added = await add(records_door, { address: 'mcp+https://tools.made-up.example/mcp', label: 'made-up' });
    assert.equal(added.source.row, 'record:tool-source:made-up');
    const kept = door.kept.get(added.source.row);
    assert.equal(kept.type, 'record:tool-source');
    assert.deepEqual(kept.value, { label: 'made-up', address: 'mcp+https://tools.made-up.example/mcp', kind: 'remote-mcp', learned: 'syntax', entry: added.entry, status: 'waiting-for-your-approval' });
    assert.ok(!('grant' in added.entry), 'the entry names no grant: the engine starts it empty');
    assert.match(added.said, /Nothing is added until you approve it/);
    await assert.rejects(add(records_door, { address: '/tmp/other', label: 'made-up' }), /already waiting or added/);
    assert.equal(door.kept.size, 1);
    assert.deepEqual(row.invoke.records.rights, [{ kind: 'record:tool-source', prefix: 'record:tool-source:', operations: ['records:list', 'records:write'] }]);
    assert.equal(row.invoke.internet, true);
  } finally { await door.close(); }
});
