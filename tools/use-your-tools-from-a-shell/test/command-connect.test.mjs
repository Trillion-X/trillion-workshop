import test from 'node:test';
import assert from 'node:assert/strict';
import { connectToolServer } from '../do-work/command.mjs';

/** A fake sign-in module: the real one's shape, with no network. */
const signIn = {
  TRADE_TOOL: 'tool:trade-a-tool-servers-sign-in-code-for-its-tokens',
  discover: async address => ({ host: new URL(address).hostname, resource: 'https://tools.example.test/', token_endpoint: 'https://auth.example.test/token' }),
  register: async (_found, redirect) => { assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/callback$/); return 'client-one'; },
  freshSignIn: () => ({ state: 'state-one', verifier: 'v'.repeat(43) }),
  authorizeAddress: (_found, clientId, redirect, { state }) => `https://auth.example.test/authorize?client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
  tradeInput: (found, clientId, redirect, fresh, callback) => {
    if (callback.state !== fresh.state) throw new Error('This sign-in has expired or was already used.');
    return { connection: { connection_id: `service_connection:tool-server:${found.host}` }, code: callback.code, client_id: clientId, redirect_uri: redirect, resource: found.resource };
  },
};

/** The person's browser: it comes back to the loopback address with the code. */
const browser = (code = 'code-one', state = 'state-one') => async link => {
  const redirect = new URL(new URL(link).searchParams.get('redirect_uri'));
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', state);
  await fetch(redirect, { redirect: 'manual' });
};

const noTyping = () => ({ line: new Promise(() => {}), stop: () => {} });

test('connect signs in at the link, has the engine trade the code, and lists the server by its address', async () => {
  const calls = [];
  const client = { op: async (address, method, input) => { calls.push({ address, method, input }); return method === 'tools:list' ? { tools: [{ id: 'list_domains' }, { id: 'check_domain' }], next: null } : { token_type: 'bearer' }; } };
  const said = [];
  const answer = await connectToolServer(client, 'https://tools.example.test/mcp', { load: async () => signIn, open: browser(), say: text => said.push(text), typed: noTyping });
  assert.deepEqual(answer, { connected: 'tools.example.test', address: 'https://tools.example.test/mcp', tools: ['list_domains', 'check_domain'] });
  assert.equal(calls[0].method, 'tools:run');
  assert.equal(calls[0].input.tool, 'tool:trade-a-tool-servers-sign-in-code-for-its-tokens');
  assert.deepEqual(calls[0].input.input.connection, { connection_id: 'service_connection:tool-server:tools.example.test' });
  assert.equal(calls[0].input.input.code, 'code-one');
  assert.deepEqual(calls[1], { address: null, method: 'tools:list', input: { address: 'https://tools.example.test/mcp' } });
  assert.ok(said.some(line => line.includes('https://auth.example.test/authorize')), 'the link is said, for a person on another device');
});

test('connect takes only an https address and names why the copy cannot sign in', async () => {
  const client = { op: async () => assert.fail('nothing is asked') };
  await assert.rejects(connectToolServer(client, 'http://tools.example.test/mcp', { load: async () => signIn }), /full web address/);
  await assert.rejects(connectToolServer(client, undefined, { load: async () => signIn }), /full web address/);
  await assert.rejects(connectToolServer(client, 'https://tools.example.test/mcp', { load: async () => null }), /cannot sign in to a tool server/);
});
