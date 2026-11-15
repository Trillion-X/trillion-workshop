import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { buildInvocation, httpJson, connectionFieldName } from '../do-work/http-invocation.mjs';
import { nodePublicFetch } from '../do-work/node-public-fetch.mjs';

const held = { url: 'https://public.example/read', connection_id: 'synthetic-connection', reply_holds_values: [{ from: 'token', keep_as_field: 'key' }] };

test('held values never escape errors, answer reports, duplicates, malformed replies or failed storage', async () => {
  for (const [status, options, reply] of [
    [400, {}, { token: 'synthetic-secret', error: 'bad synthetic-secret' }],
    [200, { answer_ok_field: 'ok' }, { ok: false, token: 'synthetic-secret', error: 'bad synthetic-secret' }],
    [200, { report_answer: true }, { token: 'synthetic-secret', duplicate: 'synthetic-secret', 'synthetic-secret': 'key echo' }],
    [200, {}, 'synthetic-secret'],
  ]) {
    let output;
    try { output = await httpJson({ invocation: { ...held, ...options }, keep: async () => {} }, async () => new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status })); }
    catch (error) { output = { message: error.message, status: error.service_answered }; }
    assert.ok(!JSON.stringify(output).includes('synthetic-secret'), 'no held credential in any output branch');
  }
  let sends = 0;
  await assert.rejects(httpJson({ invocation: held, keep: async () => { throw new Error('synthetic-secret'); } }, async () => { sends++; return new Response('{"token":"synthetic-secret"}'); }), error => error.service_answered === 200 && !error.message.includes('synthetic-secret'));
  assert.equal(sends, 1, 'failed storage never replays a possibly completed request');
});

test('the retained original exposes the held-report regression that the active owner repairs', async () => {
  const { invocationBaseline } = await import('./invocation-baseline.mjs');
  const original = await invocationBaseline();
  const invoke = { ...held, report_answer: true };
  const request = async () => new Response('{"token":"synthetic-original-leak"}');
  const before = await original.httpJson({ invocation: invoke, keep: async () => {} }, request);
  const after = await httpJson({ invocation: invoke, keep: async () => {} }, request);
  assert.match(before.answer, /synthetic-original-leak/);
  assert.ok(!after.answer.includes('synthetic-original-leak'));
});

test('pre-send refusals are explicit and no unsafe request reaches its transport', async () => {
  for (const invocation of [
    { url: 'https://127.0.0.1/read' }, { url: 'https://synthetic-secret:@public.example/read' },
    held, { url: 'https://public.example/read', credential_injections: [{ secret_name: 'synthetic', placement: {} }] },
  ]) {
    await assert.rejects(httpJson({ invocation }, () => assert.fail('refused request dispatched')), error => error.not_sent === true && !error.message.includes('synthetic-secret'));
  }
});

test('transport and unread-body failures remain private and never claim a retry is safe', async () => {
  for (const withCredentials of [false, true]) {
    let sends = 0;
    const fail = async () => { sends++; throw new Error('request contains synthetic-secret'); };
    const invocation = { url: 'https://public.example/write', credential_injections: withCredentials ? [{ secret_name: 'synthetic', placement: {} }] : [] };
    await assert.rejects(httpJson({ invocation, ...(withCredentials ? { send: fail } : {}) }, fail), error => !error.not_sent && !error.message.includes('synthetic-secret') && /unknown/.test(error.message));
    assert.equal(sends, 1);
  }
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic-secret')); } }));
  await assert.rejects(httpJson({ invocation: { url: 'https://public.example/read' } }, async () => response), error => error.service_answered === 200 && !error.not_sent && !error.message.includes('synthetic-secret'));
});

test('every redirect is checked, cross-origin credentials are removed, and manual redirects do not dispatch again', async () => {
  const calls = [];
  const result = await httpJson({ invocation: { url: 'https://public.example/read', method: 'GET', headers: { authorization: 'Bearer synthetic', cookie: 'synthetic=only' } } }, async (url, init) => {
    calls.push({ url, init }); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://other.example/read' } }) : new Response('{}');
  });
  assert.deepEqual(result, {}); assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[1].init.headers).has('authorization'), false); assert.equal(new Headers(calls[1].init.headers).has('cookie'), false);
  let privateCalls = 0;
  await assert.rejects(httpJson({ invocation: { url: 'https://public.example/write' } }, async () => { privateCalls++; return new Response(null, { status: 307, headers: { location: 'https://127.0.0.1/private' } }); }), error => !error.not_sent && /redirected address/.test(error.message));
  assert.equal(privateCalls, 1, 'no private redirect target was dispatched');
  let manualCalls = 0;
  await assert.rejects(httpJson({ invocation: { url: 'https://public.example/write', follow_redirects: false } }, async (_url, init) => { manualCalls++; assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://other.example/read' } }); }), error => error.service_answered === 302);
  assert.equal(manualCalls, 1);
});

test('actual invocation consumer uses connection-time DNS guard and rejects mixed public/private answers', async () => {
  for (const answers of [[{ address: '93.184.216.34', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    let connected = 0;
    const request = (_url, options, receive) => {
      const req = new EventEmitter(); req.destroy = error => queueMicrotask(() => req.emit('error', error));
      req.end = () => options.lookup('public.example', { all: true }, (error, chosen) => {
        if (error) return req.destroy(error);
        assert.deepEqual(chosen, answers); connected++;
        const reply = Readable.from([Buffer.from('{"read":true}')]); reply.statusCode = 200; reply.headers = {}; reply.rawHeaders = []; receive(reply);
      }); return req;
    };
    const fetch = nodePublicFetch({ resolve: async () => answers, request });
    const invocation = await buildInvocation({ url: 'https://public.example/{path}', method: 'GET' }, { request: true, input: { path: 'usage' } });
    if (answers.length === 1) assert.deepEqual(await httpJson({ invocation }, fetch), { read: true });
    else await assert.rejects(httpJson({ invocation }, fetch));
    assert.equal(connected, answers.length === 1 ? 1 : 0);
  }
});

test('input fetching cancels oversized streams and conceals read errors', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(buildInvocation({ fill: { from: 'input', field: 'file', fetch: 'base64' } }, { input: { file: 'https://public.example/file' }, needs: { max_input_bytes: 4 }, fetchBytes: async () => new Response(stream) }), /at most 4/);
  assert.equal(cancelled, true); assert.equal(pulls, 1);
  await assert.rejects(buildInvocation({ fill: { from: 'input', field: 'file', fetch: 'base64' } }, { input: { file: 'https://public.example/file' }, fetchBytes: async () => { throw new Error('synthetic-secret'); } }), error => !error.message.includes('synthetic-secret'));
});

test('held connection names and cursor paging stay compatible', async () => {
  const kept = [];
  const result = await httpJson({ invocation: { ...held, reply_cursor_paging: true }, keep: async (...args) => kept.push(args) }, async () => new Response('{"token":"synthetic-only","data":[],"paging":{"next":"https://public.example/?token=synthetic-only","cursors":{"after":"cursor"}}}'));
  assert.deepEqual(kept, [[connectionFieldName('synthetic-connection', 'key'), 'synthetic-only']]);
  assert.deepEqual(result.paging, { cursors: { after: 'cursor' }, has_next: true, has_previous: false });
  assert.equal(result.token, '[held value]');
});
