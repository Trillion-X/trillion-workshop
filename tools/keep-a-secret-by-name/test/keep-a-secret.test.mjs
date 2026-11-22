// tools/keep-a-secret-by-name/test/keep-a-secret.test.mjs
//
// Made-up door answers only. The stub door records each request body, so the test can show that the value travels in the
// body and never in an argument, a log line or the answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostsOf, keepSecret, readStdin, removeSecret, valueOf } from '../do-work/keep-a-secret.mjs';
import { engineClient } from '../../use-your-tools-from-a-shell/do-work/command.mjs';

// A door that answers each JSON-RPC call with the structured content it is given, and keeps every request body it was sent.
function stubDoor(answer) {
  const bodies = [];
  const fetchImpl = async (url, { body }) => {
    bodies.push(JSON.parse(body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: answer, isError: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = engineClient({ door: { name: 'test door', mcp: 'https://door.test/mcp' }, credential: { kind: 'key', bearer: 'nm_synthetic' }, fetchImpl });
  return { client, bodies };
}

test('a secret goes to secrets:put in the request body, under its name, and the answer carries neither the value nor a copy of it', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  const answer = await keepSecret({ name: 'synthetic-push-secret', value: 'synthetic-value-7f3a', client });
  assert.deepEqual(answer, { name: 'synthetic-push-secret', accepted: true });
  const [sent] = bodies;
  const call = sent.params.arguments;
  assert.equal(sent.params.name, 'do_one_thing_in_my_account');
  assert.equal(call.address, '@secrets');
  assert.equal(call.method, 'secrets:put');
  assert.deepEqual(call.input, { name: 'synthetic-push-secret', value: 'synthetic-value-7f3a' });
  assert.ok(!JSON.stringify(answer).includes('synthetic-value-7f3a'));
});

test('hosts travel beside the value as the input\'s hosts, and the answer names them without the value', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  const answer = await keepSecret({ name: 'synthetic-push-secret', value: 'synthetic-value-7f3a', hosts: hostsOf('api.example.com, mcp.example.com'), client });
  assert.deepEqual(answer, { name: 'synthetic-push-secret', accepted: true, hosts: ['api.example.com', 'mcp.example.com'] });
  assert.deepEqual(bodies[0].params.arguments.input,
    { name: 'synthetic-push-secret', value: 'synthetic-value-7f3a', hosts: ['api.example.com', 'mcp.example.com'] });
  assert.ok(!JSON.stringify(answer).includes('synthetic-value-7f3a'));
});

test('--hosts with no host is refused before any call is sent', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  await assert.rejects(keepSecret({ name: 'synthetic-push-secret', value: 'x', hosts: hostsOf(' , '), client }), /at least one host/);
  assert.equal(bodies.length, 0);
});

test('a door that does not accept the value is an error, never a silent success', async () => {
  const { client } = stubDoor({ accepted: false });
  await assert.rejects(keepSecret({ name: 'synthetic-push-secret', value: 'x', client }), /did not accept/);
});

test('an empty value and a missing name are refused before any call is sent', async () => {
  const { client, bodies } = stubDoor({ accepted: true });
  await assert.rejects(keepSecret({ name: 'synthetic-push-secret', value: '', client }), /empty/);
  await assert.rejects(keepSecret({ name: '', value: 'x', client }), /Name the secret/);
  assert.equal(bodies.length, 0);
});

test('stdin keeps every byte of the value except one trailing newline', async () => {
  assert.equal(valueOf('abc\n'), 'abc');
  assert.equal(valueOf('abc\r\n'), 'abc');
  assert.equal(valueOf('ab\nc'), 'ab\nc');
  const stream = (await import('node:stream')).Readable.from([Buffer.from('se'), Buffer.from('cret\n')]);
  assert.equal(valueOf(await readStdin(stream)), 'secret');
});

test('a removal goes to secrets:remove with the name alone, and the answer says whether a value was held and what is known at the issuer', async () => {
  const held = stubDoor({ name: 'synthetic-old-key', removed: true });
  assert.deepEqual(await removeSecret({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: held.client }),
    { name: 'synthetic-old-key', removed: true, issuer_status: 'revoked' });
  const call = held.bodies[0].params.arguments;
  assert.equal(call.address, '@secrets');
  assert.equal(call.method, 'secrets:remove');
  assert.deepEqual(call.input, { name: 'synthetic-old-key' });
  const absent = stubDoor({ name: 'synthetic-old-key', removed: false });
  assert.deepEqual(await removeSecret({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: absent.client }),
    { name: 'synthetic-old-key', removed: false, issuer_status: 'unknown' });
});

test('a removal away from the writer says it was queued, and an answer that says neither is an error', async () => {
  const queued = stubDoor({ name: 'synthetic-old-key', queued: true });
  assert.deepEqual(await removeSecret({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: queued.client }),
    { name: 'synthetic-old-key', queued: true, issuer_status: 'unknown' });
  const unclear = stubDoor({});
  await assert.rejects(removeSecret({ name: 'synthetic-old-key', issuerStatus: 'unknown', client: unclear.client }), /did not answer the removal/);
});

test('a removal is refused before any call is sent when it has no name or says nothing about the issuer', async () => {
  const { client, bodies } = stubDoor({ removed: true });
  await assert.rejects(removeSecret({ name: '', issuerStatus: 'revoked', client }), /Name the secret/);
  await assert.rejects(removeSecret({ name: 'synthetic-old-key', client }), /--issuer-status revoked or unknown/);
  await assert.rejects(removeSecret({ name: 'synthetic-old-key', issuerStatus: 'maybe', client }), /--issuer-status revoked or unknown/);
  assert.equal(bodies.length, 0);
});

test('a removal sends the same request key each time it is made, so a retry after a timeout is the same call', async () => {
  const first = stubDoor({ name: 'synthetic-old-key', removed: true });
  const second = stubDoor({ name: 'synthetic-old-key', removed: true });
  await removeSecret({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: first.client });
  await removeSecret({ name: 'synthetic-old-key', issuerStatus: 'revoked', client: second.client });
  assert.equal(first.bodies[0].params.arguments.request_key, second.bodies[0].params.arguments.request_key);
});

// A made-up home holding one installed site: the tool, run as its own file, must speak for that site and find its sign-in.
test('run under its own name, the tool fills the site words and finds the installed sign-in', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const command = await import('../../use-your-tools-from-a-shell/do-work/command.mjs');
  const { credentialFor, doorFor, grantStore, installedCli, keyStore, siteOf, speakFor } = command;
  const home = mkdtempSync(join(tmpdir(), 'keep-secret-home-'));
  try {
    const state = join(home, '.example-cli', 'cli');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'site.json'), JSON.stringify({ origin: 'https://example.com', site_name: 'Example', cli: 'example-cli' }));
    assert.equal(installedCli({ home }), 'example-cli');
    const rules = structuredClone((await import('../../use-your-tools-from-a-shell/do-work/command.json', { with: { type: 'json' } })).default);
    speakFor(siteOf({ invoked: 'example-cli', home, rules }), rules);
    assert.ok(!/\{(site_name|cli)\}/.test(rules.words.no_origin), 'no placeholder is left in the sentence');
    assert.match(rules.words.no_origin, /Example/);
    const grants = grantStore({ rules, home, platform: 'linux' });
    grants.write({ access_token: 'synthetic-token', origin: 'https://example.com', resource: 'https://example.com/mcp' });
    const credential = await credentialFor({ home, rules, env: {}, grants, store: keyStore({ rules, home, platform: 'linux' }) });
    assert.equal(credential?.bearer, 'synthetic-token');
    assert.equal(doorFor({ credential, rules, localMcp: null }).mcp, 'https://example.com/mcp');
    // Two installed sites: it never guesses.
    mkdirSync(join(home, '.other-cli', 'cli'), { recursive: true });
    writeFileSync(join(home, '.other-cli', 'cli', 'site.json'), '{}');
    assert.equal(installedCli({ home }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
