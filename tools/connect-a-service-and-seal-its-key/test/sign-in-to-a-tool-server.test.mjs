import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAddress, challengeOf, connectionOf, discover, freshSignIn, register, tradeInput, TRADE_TOOL } from '../do-work/sign-in-to-a-tool-server.mjs';

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A made-up server whose sign-in lives at auth.example.test, answering as a real one does (Namecheap's shape, Nov 18 2026). */
function server({ pkce = ['S256'], registration = true, issuer = 'https://auth.example.test' } = {}) {
  const asked = [];
  const send = async (address, init = {}) => {
    asked.push({ address: String(address), method: init.method ?? 'GET', body: init.body ?? null });
    const url = new URL(address);
    if (url.href === 'https://tools.example.test/mcp' && init.method === 'POST') {
      return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer resource_metadata="https://tools.example.test/.well-known/oauth-protected-resource", scope="openid offline_access tools.read"' });
    }
    if (url.href === 'https://tools.example.test/.well-known/oauth-protected-resource') return json(200, { resource: 'https://tools.example.test/', authorization_servers: [issuer] });
    if (url.href === 'https://auth.example.test/.well-known/oauth-authorization-server') {
      return json(200, { issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/connect/authorize', token_endpoint: 'https://auth.example.test/connect/token',
        code_challenge_methods_supported: pkce, ...(registration ? { registration_endpoint: 'https://tools.example.test/register' } : {}) });
    }
    if (url.href === 'https://tools.example.test/register') return json(201, { client_id: 'client-one', token_endpoint_auth_method: 'none' });
    return json(404, {});
  };
  return { send, asked };
}

test('a server is found from its 401 challenge, its resource document and its authorization server', async () => {
  const { send } = server();
  const found = await discover('https://tools.example.test/mcp', { send });
  assert.deepEqual(found, { host: 'tools.example.test', issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/connect/authorize',
    token_endpoint: 'https://auth.example.test/connect/token', registration_endpoint: 'https://tools.example.test/register', scope: 'openid offline_access tools.read', resource: 'https://tools.example.test/' });
  assert.equal(await register(found, 'http://127.0.0.1:5000/callback', { send, name: 'Example' }), 'client-one');
});

test('a server with no PKCE S256, no registration or a plain http address is refused in plain words', async () => {
  await assert.rejects(discover('https://tools.example.test/mcp', { send: server({ pkce: ['plain'] }).send }), /PKCE S256/);
  const found = await discover('https://tools.example.test/mcp', { send: server({ registration: false }).send });
  await assert.rejects(register(found, 'http://127.0.0.1:5000/callback', { send: server().send, name: 'Example' }), /register itself/);
  await assert.rejects(discover('http://tools.example.test/mcp'), /not on https/);
});

test('the sign-in address carries PKCE, the resource and the state; the trade input names the host connection and refuses another state', async () => {
  const found = await discover('https://tools.example.test/mcp', { send: server().send });
  const fresh = freshSignIn();
  const link = new URL(authorizeAddress(found, 'client-one', 'http://127.0.0.1:5000/callback', fresh));
  assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(link.searchParams.get('resource'), 'https://tools.example.test/');
  assert.equal(link.searchParams.get('state'), fresh.state);
  assert.ok(!link.href.includes(fresh.verifier), 'the verifier never leaves this computer');
  const input = tradeInput(found, 'client-one', 'http://127.0.0.1:5000/callback', fresh, { state: fresh.state, code: 'code-one' });
  assert.deepEqual(input.connection, { connection_id: connectionOf('tools.example.test') });
  assert.equal(input.connection.connection_id, 'service_connection:tool-server:tools.example.test');
  assert.equal(input.resource, 'https://tools.example.test/');
  assert.equal(TRADE_TOOL, 'tool:trade-a-tool-servers-sign-in-code-for-its-tokens');
  assert.throws(() => tradeInput(found, 'client-one', 'x', fresh, { state: 'another', code: 'code-one' }), /expired or was already used/);
  assert.throws(() => tradeInput(found, 'client-one', 'x', fresh, { state: fresh.state, error: 'access_denied' }), /did not finish signing in/);
});

test('a challenge is read quoted or bare', () => {
  assert.deepEqual(challengeOf('Bearer resource_metadata="https://a.test/r", scope="x y"'), { resource_metadata: 'https://a.test/r', scope: 'x y' });
  assert.deepEqual(challengeOf('Bearer resource_metadata=https://a.test/r'), { resource_metadata: 'https://a.test/r', scope: null });
  assert.deepEqual(challengeOf(null), { resource_metadata: null, scope: null });
});
