import test from 'node:test';
import assert from 'node:assert/strict';
import { addedToolServerSource, toolServerLifecycle } from '../do-work/tool-server-lifecycle.mjs';

const SERVER = 'https://remote.example.com/mcp';
const RETURN = 'https://native.example.com/tool-servers/signed-in';
const CODE = 'synthetic-one-use-authorization-code';
const CALLBACK = 'native-callback:synthetic';
function fixture({ needsSignIn = false, keyRefused = false, exchangeUnknown = false, exchangeRefused = false, existingKey = false, failPublicationOnce = false, returnTo = RETURN } = {}) {
  const facts = new Map(), calls = [], states = new Map(), receipts = new Map();
  const requestKey = 'original-native-request:synthetic';
  let current = true, signed = false, exchanges = 0, stamp = Date.parse('2026-11-08T12:00:00Z');
  const native = {
    facts: {
      read: async key => structuredClone(facts.get(key) ?? null),
      write: async (key, value) => { calls.push(['write', key]); if (failPublicationOnce && key === `tool-server:${SERVER}`) { failPublicationOnce = false; throw new Error('synthetic-publication-interrupted'); } facts.set(key, structuredClone(value)); },
      consumePending: async (key, callback) => { const value = facts.get(key) ?? null; if (value && callback.callback_intake !== CALLBACK) throw new Error('native_callback_binding_refused'); facts.delete(key); return structuredClone(value); },
    },
    vault: {
      acceptKeyIntake: async ({ intake }) => { assert.equal(intake, 'native-intake:synthetic'); calls.push(['key-intake', existingKey ? 'replaced' : 'created']); return { changed: true, rollback_handle: 'native-generation:synthetic' }; },
      rollbackKey: async value => { assert.equal(value.rollback_handle, 'native-generation:synthetic'); calls.push(['rollback-key']); },
      createVerifier: async ({ state }) => { calls.push(['verifier', state]); return { challenge: 'A'.repeat(43) }; },
      removeVerifier: async ({ state }) => { calls.push(['remove-verifier', state]); },
      exchangeAndKeep: async input => {
        assert.equal(input.callback_intake, CALLBACK); assert.ok(!('code' in input)); assert.equal(input.server, SERVER); assert.equal(input.redirect_uri, returnTo); exchanges += 1;
        const { state, callback_intake, ...pending } = input;
        receipts.set(state, { status: 'unknown', request_key: requestKey });
        if (exchangeUnknown) throw Object.assign(new Error(`must not leak ${CODE}`), { outcome: 'unknown', request_key: requestKey });
        if (exchangeRefused) { receipts.set(state, { status: 'refused', request_key: requestKey }); throw Object.assign(new Error('synthetic-known-refusal'), { request_key: requestKey }); }
        signed = true; const result = { kept: true, expires_at: new Date(stamp + 3600000).toISOString() };
        receipts.set(state, { status: 'kept', pending, result, request_key: requestKey }); return result;
      },
    },
    callbacks: { remember: async ({ state, expires_at }) => { states.set(state, expires_at); }, forget: async state => { states.delete(state); }, recover: async state => structuredClone(receipts.get(state) ?? null) },
    assertCurrent: async () => { if (!current) throw new Error('native_source_withdrawn'); },
    admitAddress: async url => { assert.equal(new URL(url).protocol, 'https:'); if (new URL(url).hostname === '127.0.0.1') throw new Error('private_address_refused'); },
    clientName: 'Synthetic fixture', returnTo, now: () => stamp,
    rowSources: async () => [],
    random: bytes => { bytes.fill(7); return bytes; },
    request: async (url, init) => {
      const address = new URL(url);
      if (address.pathname.includes('oauth-protected-resource')) return Response.json({ resource: SERVER, authorization_servers: ['https://issuer.example.com'] });
      if (address.pathname.includes('oauth-authorization-server')) return Response.json({ issuer: 'https://issuer.example.com', authorization_endpoint: 'https://issuer.example.com/authorize', token_endpoint: 'https://issuer.example.com/token', registration_endpoint: 'https://issuer.example.com/register', code_challenge_methods_supported: ['S256'] });
      if (address.pathname === '/register') { assert.equal(JSON.parse(init.body).token_endpoint_auth_method, 'none'); return Response.json({ client_id: 'synthetic-client' }); }
      throw new Error('unexpected public fixture request');
    },
    postFor: async source => async ({ body }) => {
      const message = JSON.parse(body); calls.push(['protocol', message.method]);
      if (keyRefused || needsSignIn && !signed) return { status: 401, headers: {}, text: '' };
      if (source.list.mcp.sign_in) assert.ok(facts.has(`tool-server:${SERVER}`), 'the native host requires persisted metadata plus its held token');
      return { status: message.id === undefined ? 202 : 200, headers: {}, text: message.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [{ name: 'echo' }] } }) };
    },
  };
  return { lifecycle: toolServerLifecycle(native), restart: () => toolServerLifecycle(native), facts, calls, states, receipts, requestKey, current: value => { current = value; }, time: value => { stamp = value; }, exchanges: () => exchanges };
}

test('the lifecycle needs the actual native host and refuses raw key input', async () => {
  assert.throws(() => toolServerLifecycle(), /tool_server_native_lifecycle_unmounted/);
  const made = fixture();
  await assert.rejects(made.lifecycle.add({ server: SERVER, key: 'synthetic raw key forbidden' }), /tool_server_add_input_refused/);
  assert.deepEqual(made.calls, []);
});

test('public addition preserves the complete original built source and ID spelling', async () => {
  const made = fixture();
  assert.deepEqual(await made.lifecycle.add({ server: SERVER, name: 'Remote' }), { server: SERVER, name: 'Remote', tools: 1, state: 'ready' });
  const source = made.facts.get(`tool-server-added:${SERVER}`);
  assert.deepEqual(source, addedToolServerSource(SERVER, 'Remote'));
  assert.match(source.id, /^source:added-tool-server:[a-f0-9]{16}$/);
  assert.equal(source.id_prefix, `tool:added:${source.id.split(':').at(-1)}:`);
});

test('key intake verifies new and replacement keys and rolls back only its own changed generation', async () => {
  for (const existingKey of [false, true]) {
    const made = fixture({ keyRefused: true, existingKey });
    await assert.rejects(made.lifecycle.add({ server: SERVER, key_intake: 'native-intake:synthetic' }), /tool_server_key_refused/);
    assert.ok(!made.facts.has(`tool-server-added:${SERVER}`));
    assert.equal(made.calls.filter(([what]) => what === 'rollback-key').length, 1);
  }
  const made = fixture();
  assert.equal((await made.lifecycle.add({ server: SERVER, key_intake: 'native-intake:synthetic', key_header: 'x-api-key', key_prefix: '' })).state, 'ready');
  assert.deepEqual(made.facts.get(`tool-server-added:${SERVER}`).list.mcp.key, { kind: 'header', name: 'x-api-key', prefix: '' });
  const reconnect = fixture({ existingKey: true });
  assert.equal((await reconnect.lifecycle.add({ server: SERVER, key_intake: 'native-intake:synthetic' })).state, 'ready');
  assert.ok(reconnect.calls.some(([what, change]) => what === 'key-intake' && change === 'replaced'));
  assert.ok(!reconnect.calls.some(([what]) => what === 'rollback-key'));
});

test('PKCE setup and callback use existing protocol helpers and consume state before token exchange', async () => {
  const made = fixture({ needsSignIn: true });
  const offered = await made.lifecycle.add({ server: SERVER, name: 'Remote' });
  const open = new URL(offered.open), state = open.searchParams.get('state');
  assert.equal(open.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(open.searchParams.get('redirect_uri'), RETURN);
  assert.equal(state.length, 48); assert.ok(made.states.has(state));
  const answers = await Promise.allSettled([made.lifecycle.finish({ state, callback_intake: CALLBACK }), made.lifecycle.finish({ state, callback_intake: CALLBACK })]);
  assert.ok(answers.some(answer => answer.status === 'fulfilled'));
  assert.equal(made.exchanges(), 1); assert.ok(!made.states.has(state));
  assert.ok(!JSON.stringify([...made.facts]).includes(CODE));
  assert.equal(made.facts.get(`tool-server:${SERVER}`).server, SERVER);
});

test('a lost token-exchange reply cannot reuse code/verifier or expose the code in an error', async () => {
  const made = fixture({ needsSignIn: true, exchangeUnknown: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), error => error.code === 'tool_server_exchange_unknown' && error.outcome === 'unknown' && !error.message.includes(CODE));
  await assert.rejects(made.restart().finish({ state }), error => error.code === 'tool_server_exchange_unknown' && error.request_key === made.requestKey);
  assert.equal(made.exchanges(), 1); assert.ok(!made.facts.has(`tool-server:${SERVER}`));
});

test('expired, future and withdrawn callback custody never sends an exchange', async () => {
  for (const delta of [16 * 60000, -60000]) {
    const made = fixture({ needsSignIn: true });
    const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
    made.time(Date.parse('2026-11-08T12:00:00Z') + delta);
    await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), /tool_server_pending_expired/);
    assert.equal(made.exchanges(), 0);
  }
  const made = fixture({ needsSignIn: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  made.current(false);
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), /native_source_withdrawn/);
  assert.equal(made.exchanges(), 0);
});


test('raw authorization codes are refused before pending state is consumed', async () => {
  const made = fixture({ needsSignIn: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, code: CODE }), /tool_server_callback_input_refused/);
  assert.ok(made.facts.has(`tool-server-pending:${state}`));
  assert.equal(made.exchanges(), 0);
  assert.equal((await made.lifecycle.finish({ state, callback_intake: CALLBACK })).state, 'ready');
});


test('a mismatched callback handle or state cannot consume another original pending attempt', async () => {
  const made = fixture({ needsSignIn: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: 'wrong-native-callback' }), /native_callback_binding_refused/);
  await assert.rejects(made.lifecycle.finish({ state: 'b'.repeat(48), callback_intake: CALLBACK }), /tool_server_pending_consumed/);
  assert.ok(made.facts.has(`tool-server-pending:${state}`));
  assert.equal((await made.lifecycle.finish({ state, callback_intake: CALLBACK })).state, 'ready');
  assert.equal(made.exchanges(), 1);
});

test('known sealed receipt completes interrupted publication after restart without raw intake or exchange', async () => {
  const made = fixture({ needsSignIn: true, failPublicationOnce: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), /synthetic-publication-interrupted/);
  assert.equal(made.exchanges(), 1);
  made.time(Date.parse('2026-11-08T13:00:00Z'));
  assert.equal((await made.restart().finish({ state })).state, 'ready');
  const published = structuredClone(made.facts.get(`tool-server:${SERVER}`));
  const writes = made.calls.filter(([what, key]) => what === 'write' && key === `tool-server:${SERVER}`).length;
  made.time(Date.parse('2026-11-08T13:30:00Z'));
  assert.equal((await made.restart().finish({ state })).state, 'ready');
  assert.deepEqual(made.facts.get(`tool-server:${SERVER}`), published);
  assert.equal(made.calls.filter(([what, key]) => what === 'write' && key === `tool-server:${SERVER}`).length, writes);
  assert.equal(made.exchanges(), 1);
  assert.ok(!JSON.stringify([...made.receipts]).includes(CODE));
  assert.ok(!JSON.stringify([...made.receipts]).includes(CALLBACK));
});

test('known refusal and unresolved unknown retain the original receipt key across restart', async () => {
  for (const exchangeRefused of [false, true]) {
    const made = fixture({ needsSignIn: true, exchangeUnknown: !exchangeRefused, exchangeRefused });
    const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
    const code = exchangeRefused ? 'tool_server_exchange_refused' : 'tool_server_exchange_unknown';
    await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), error => error.code === code && error.request_key === made.requestKey);
    await assert.rejects(made.restart().finish({ state }), error => error.code === code && error.request_key === made.requestKey);
    assert.equal(made.exchanges(), 1);
    assert.ok(!made.facts.has(`tool-server:${SERVER}`));
  }
});

test('withdrawn original caller withholds known sealed receipt publication', async () => {
  const made = fixture({ needsSignIn: true, failPublicationOnce: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), /synthetic-publication-interrupted/);
  made.current(false);
  await assert.rejects(made.restart().finish({ state }), /native_source_withdrawn/);
  assert.equal(made.exchanges(), 1);
  assert.ok(!made.facts.has(`tool-server:${SERVER}`));
});

test('an old sealed receipt cannot overwrite a later authorization', async () => {
  const made = fixture({ needsSignIn: true, failPublicationOnce: true });
  const state = new URL((await made.lifecycle.add({ server: SERVER })).open).searchParams.get('state');
  await assert.rejects(made.lifecycle.finish({ state, callback_intake: CALLBACK }), /synthetic-publication-interrupted/);
  const later = { server: SERVER, authorization_state: 'b'.repeat(48), client_id: 'later-native-client' };
  made.facts.set(`tool-server:${SERVER}`, structuredClone(later));
  await assert.rejects(made.restart().finish({ state }), /tool_server_authorization_replaced/);
  assert.deepEqual(made.facts.get(`tool-server:${SERVER}`), later);
  assert.equal(made.exchanges(), 1);
});


test('the admitted native callback can use its exact RFC 8252 loopback listener', async () => {
  for (const returnTo of ['http://127.0.0.1:47123/tool-servers/signed-in', 'http://[::1]:47123/tool-servers/signed-in']) {
    const made = fixture({ needsSignIn: true, returnTo });
    const open = new URL((await made.lifecycle.add({ server: SERVER })).open);
    assert.equal(open.searchParams.get('redirect_uri'), returnTo);
    assert.equal((await made.lifecycle.finish({ state: open.searchParams.get('state'), callback_intake: CALLBACK })).state, 'ready');
  }
  for (const returnTo of ['http://remote.example/callback', 'http://127.0.0.1:47123/callback?code=forbidden', 'https://user:password@example.com/callback']) {
    assert.throws(() => fixture({ returnTo }), /tool_server_callback_address_refused/);
  }
});
