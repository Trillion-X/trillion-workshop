// tools/add-tool-source/test/add-tool-source.test.mjs
//
// The tool that adds a source of tools from one address, over a stand-in records door (tools/records-door/test/fake-door.mjs) that
// holds exactly the rights the row declares and a stand-in web whose servers answer as an MCP server, as a git repository, as both
// or as neither. Every address, host, commit and label is made up.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import test from 'node:test';
import { createHash } from 'node:crypto';
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
    if (server.oauth) return oauthWorld(server.oauth, url, init);
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

/** A server that asks for a sign-in, its protected-resource document, its authorization server's metadata and registration. */
function oauthWorld(how, url, init) {
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const issuer = 'https://auth.made-up.example';
  if (url.hostname === 'oauth.made-up.example') {
    if (init.method === 'POST') return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://oauth.made-up.example/.well-known/oauth-protected-resource/mcp", scope="tools.read"' } });
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: 'https://oauth.made-up.example/mcp', authorization_servers: [issuer], scopes_supported: ['tools.read'] });
  }
  if (url.hostname === 'auth.made-up.example') {
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      if (how === 'no-metadata') return new Response('', { status: 404 });
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, ...(how === 'no-registration' ? {} : { registration_endpoint: `${issuer}/register` }), code_challenge_methods_supported: how === 'no-pkce' ? ['plain'] : ['S256'] });
    }
    if (url.pathname === '/register' && init.method === 'POST') {
      const asked = JSON.parse(init.body);
      return how === 'refuse-registration' ? json({ error: 'invalid_client_metadata' }, 400) : json({ client_id: 'public-client-1', redirect_uris: asked.redirect_uris }, 201);
    }
  }
  return new Response('', { status: 404 });
}

const REDIRECT = 'https://signin.example.test/connect/tool-server/callback';
const SETTING = { id: 'record:setting:tool-server-sign-in', type: 'record:setting', value: { redirect_uri: REDIRECT } };

async function open(records = [], toolRuns = {}) {
  const door = await startFakeDoor({ rights: rightsOf(row), records, runs: row.invoke.records.runs, toolRuns });
  return { door, records_door: openRecordsDoor({ descriptor: door.descriptor }) };
}

const add = (records_door, input, as = {}) => addToolSource(input, { door: records_door, fetch: web(as).send });

test('a path, a prefix and a listed git host are known by their syntax and nothing more is asked of the web', async () => {
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
    assert.deepEqual(being.asked.map(sent => sent.address), ['https://tools.made-up.example/mcp'], 'a server of the person over https is asked once whether it wants a sign-in; every other syntax asks the web nothing');
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

test('a bare https address is looked at once: an MCP server by initialize or as a stream, a git repository by its refs', async () => {
  const { door, records_door } = await open();
  try {
    const answers = { 'a.made-up.example': { mcp: 'json' }, 'b.made-up.example': { mcp: 'stream' } };
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

test('the source is kept as one request waiting for the person, once, and the row can touch nothing else', async () => {
  const { door, records_door } = await open();
  try {
    const added = await add(records_door, { address: 'mcp+https://tools.made-up.example/mcp', label: 'made-up' });
    assert.equal(added.source.row, 'record:tool-source-request:made-up');
    const kept = door.kept.get(added.source.row);
    assert.equal(kept.type, 'record:tool-source-request');
    assert.deepEqual(kept.value, { label: 'made-up', address: 'mcp+https://tools.made-up.example/mcp', kind: 'remote-mcp', learned: 'syntax', entry: added.entry, approve: added.approve, status: 'pending' });
    assert.ok(!('grant' in added.entry), 'the entry names no grant: the engine starts it empty');
    assert.match(added.said, /Nothing is added until you approve it/);
    await assert.rejects(add(records_door, { address: '/tmp/other', label: 'made-up' }), /already waiting or added/);
    assert.equal(door.kept.size, 1);
    assert.deepEqual(rightsOf(row), [{ kind: 'record:tool-source-request', prefix: 'record:tool-source-request:', operations: ['records:list', 'records:write'] }, { kind: 'tool-server-sign-in-pending', operations: ['records:read', 'records:list', 'records:write'] }, { kind: 'record:setting', id: 'record:setting:tool-server-sign-in', operations: ['records:read'] }]);
    assert.equal(row.invoke.internet, true);
  } finally { await door.close(); }
});

test('a server that asks for a sign-in names the vault secret its bearer is read from, by name or by a service connection field', async () => {
  const { door, records_door } = await open();
  try {
    const hex = text => Buffer.from(text).toString('hex');
    const named = await add(records_door, { address: 'mcp+https://tools.made-up.example/mcp', label: 'one', credential: 'made-up-token' });
    assert.equal(named.entry.remote.credential, 'made-up-token');
    const field = await add(records_door, { address: 'mcp+https://ads.made-up.example/mcp', label: 'two', connection: { connection_id: 'service_connection:made-up-ads', field_id: 'access_token' } });
    assert.equal(field.entry.remote.credential, `service-connection-${hex('service_connection:made-up-ads')}-field-${hex('access_token')}`);
    assert.deepEqual(field.approve.input.entry, field.entry);
    await assert.rejects(add(records_door, { address: '/opt/example-tools/x', credential: 'made-up-token' }), /belongs to a remote MCP server/);
    await assert.rejects(add(records_door, { address: 'mcp+https://a.made-up.example/mcp', credential: 'a', connection: {} }), /either a credential/);
    await assert.rejects(add(records_door, { address: 'mcp+https://a.made-up.example/mcp', credential: 'has a space' }), /name of a secret/);
    await assert.rejects(add(records_door, { address: 'mcp+https://a.made-up.example/mcp', connection: { connection_id: 'other:x', field_id: 'f' } }), /name of a secret/);
  } finally { await door.close(); }
});

const TRADE = 'tool:trade-a-tool-servers-sign-in-code-for-its-tokens';
const ASKS = { 'oauth.made-up.example': { oauth: 'works' }, 'auth.made-up.example': { oauth: 'works' } };

test('a server that asks for a sign-in is found, registered with and sent to its own sign-in page with PKCE, and nothing is kept as a source', async () => {
  const { door, records_door } = await open([SETTING]);
  try {
    const added = await add(records_door, { address: 'https://oauth.made-up.example/mcp', label: 'oauth' }, ASKS);
    assert.deepEqual([added.source.kind, added.source.learned, added.source.row], ['remote-mcp', 'probe', null]);
    const link = new URL(added.sign_in.authorize_url);
    assert.equal(`${link.origin}${link.pathname}`, 'https://auth.made-up.example/authorize');
    const query = Object.fromEntries(link.searchParams);
    assert.deepEqual([query.response_type, query.client_id, query.redirect_uri, query.code_challenge_method, query.resource, query.scope],
      ['code', 'public-client-1', REDIRECT, 'S256', 'https://oauth.made-up.example/mcp', 'tools.read']);
    assert.match(query.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(query.state.length >= 32);
    assert.equal(added.sign_in.host, 'auth.made-up.example');
    assert.match(added.said, /Nothing is added until you approve it/);
    // The pending sign-in holds the verifier and the entry the engine will read, under the state's digest only.
    const pending = [...door.kept.values()].filter(record => record.type === 'tool-server-sign-in-pending');
    assert.equal(pending.length, 1);
    assert.ok(!pending[0].id.includes(query.state));
    assert.deepEqual(pending[0].value.entry.remote, { url: 'https://oauth.made-up.example/mcp', sign_in: { token_url: 'https://auth.made-up.example/token', client_id: 'public-client-1' } });
    assert.equal(createHash('sha256').update(pending[0].value.code_verifier).digest('base64url'), query.code_challenge);
    assert.equal([...door.kept.values()].filter(record => record.type === 'record:tool-source-request').length, 0, 'no request for approval before the person has signed in');
    assert.ok(!JSON.stringify(added).includes(pending[0].value.code_verifier), 'the verifier is in no answer');
  } finally { await door.close(); }
});

test('a server whose sign-in cannot be used is refused in one plain line and nothing is kept', async () => {
  const { door, records_door } = await open([SETTING]);
  try {
    const world = how => ({ 'oauth.made-up.example': { oauth: how }, 'auth.made-up.example': { oauth: how } });
    await assert.rejects(add(records_door, { address: 'https://oauth.made-up.example/mcp' }, world('no-pkce')), /does not offer the sign-in protection .*\(PKCE S256\)/);
    await assert.rejects(add(records_door, { address: 'https://oauth.made-up.example/mcp' }, world('no-registration')), /does not let a new caller register itself/);
    await assert.rejects(add(records_door, { address: 'https://oauth.made-up.example/mcp' }, world('refuse-registration')), /refused to register this caller/);
    await assert.rejects(add(records_door, { address: 'https://oauth.made-up.example/mcp' }, world('no-metadata')), /does not publish its sign-in addresses/);
    assert.equal(door.kept.size, 1, 'only the setting is there');
  } finally { await door.close(); }
});

test('the person comes back with a code: it is traded by the trade row, the pending sign-in is used once, and the request waits for approval with the entry the engine reads', async () => {
  const traded = [];
  const { door, records_door } = await open([SETTING], { [TRADE]: input => { traded.push(input); return { token_type: 'bearer', access_token: 'held-word', refresh_token: 'held-word' }; } });
  try {
    const added = await add(records_door, { address: 'https://oauth.made-up.example/mcp', label: 'oauth' }, ASKS);
    const { state } = Object.fromEntries(new URL(added.sign_in.authorize_url).searchParams);
    const verifier = [...door.kept.values()].find(record => record.type === 'tool-server-sign-in-pending').value.code_verifier;
    await assert.rejects(addToolSource({ callback: { state: 'not-a-state', code: 'c' } }, { door: records_door }), /expired or was already used/);
    const done = await addToolSource({ callback: { state, code: 'the-code' } }, { door: records_door });
    assert.deepEqual(traded, [{ connection: { connection_id: 'service_connection:tool-server:oauth' }, token_url: 'https://auth.made-up.example/token', code: 'the-code', redirect_uri: REDIRECT, code_verifier: verifier, client_id: 'public-client-1', resource: 'https://oauth.made-up.example/mcp' }]);
    assert.equal(done.source.row, 'record:tool-source-request:oauth');
    assert.deepEqual(done.approve, { address: '@tools', method: 'tools:add-source', input: { entry: done.entry, learned: 'probe' } });
    assert.deepEqual(done.entry.remote.sign_in, { token_url: 'https://auth.made-up.example/token', client_id: 'public-client-1' });
    assert.ok(!('credential' in done.entry.remote) && !('grant' in done.entry));
    const kept = door.kept.get('record:tool-source-request:oauth');
    assert.equal(kept.value.status, 'pending');
    assert.equal([...door.kept.values()].filter(record => record.type === 'tool-server-sign-in-pending').length, 0, 'a state is used once');
    assert.ok(!JSON.stringify([done, kept]).includes('the-code') && !JSON.stringify([done, kept]).includes(verifier), 'no code or verifier is kept or answered');
    await assert.rejects(addToolSource({ callback: { state, code: 'the-code' } }, { door: records_door }), /expired or was already used/);
  } finally { await door.close(); }
});

test('a sign-in with no page to come back to is not started', async () => {
  const { door, records_door } = await open();
  try {
    await assert.rejects(add(records_door, { address: 'https://oauth.made-up.example/mcp' }, ASKS), /has not said which page/);
    assert.equal(door.kept.size, 0);
  } finally { await door.close(); }
});

test('a sign-in the person did not finish, or that the token request refused, keeps nothing', async () => {
  const { door, records_door } = await open([SETTING], { [TRADE]: () => { throw new Error('the server answered 400'); } });
  try {
    const first = await add(records_door, { address: 'https://oauth.made-up.example/mcp', label: 'oauth' }, ASKS);
    const stateOf = added => Object.fromEntries(new URL(added.sign_in.authorize_url).searchParams).state;
    await assert.rejects(addToolSource({ callback: { state: stateOf(first), error: 'access_denied' } }, { door: records_door }), /did not finish signing in to oauth/);
    const again = await add(records_door, { address: 'https://oauth.made-up.example/mcp', label: 'oauth' }, ASKS);
    await assert.rejects(addToolSource({ callback: { state: stateOf(again), code: 'c' } }, { door: records_door }), /did not finish: the server answered 400/);
    assert.equal([...door.kept.values()].filter(record => record.type === 'record:tool-source-request').length, 0);
  } finally { await door.close(); }
});
