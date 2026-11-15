import test from 'node:test';
import assert from 'node:assert/strict';
import { invocationBaseline } from './invocation-baseline.mjs';
const { buildInvocation, encodeBody, httpJson, connectionFieldName } = process.env.HTTP_INVOCATION_UNDER_TEST === 'adapted' ? await import('../do-work/http-invocation.mjs') : await invocationBaseline();

test('retained renderer resolves invoke fills and the original typed request grammar', async () => {
  const template = { url: 'https://api.example.com/{path}?q={query}', method: 'POST', query: { tag: { from: 'tags' }, skip: { from: 'absent', optional: true } },
    headers: { x: { const: '{literal}' } }, body_template: { count: '{count}', yes: { from: 'items.0.ok' }, fallback: { from: 'missing', otherwise: 4 },
      gone: { $when: 'empty', value: 3 }, day: { $time: { days: -1, as: 'date' } }, literal: { const: '{value}' } } };
  const before = structuredClone(template);
  const built = await buildInvocation(template, { request: true, input: { path: 'a/b', query: 'a & b', count: 2, tags: ['x', 'y'], items: [{ ok: false }], empty: '' }, task: { started_at: '2026-11-08T12:00:00Z' } });
  assert.equal(built.url, 'https://api.example.com/a/b?q=a%20%26%20b');
  assert.deepEqual(built.body_template, { count: 2, yes: false, fallback: 4, day: '2026-11-07', literal: '{value}' });
  assert.deepEqual(built.query, { tag: ['x', 'y'] }); assert.deepEqual(template, before);
  assert.deepEqual(await buildInvocation({ a: { fill: { from: 'input', field: 'count' } } }, { input: { count: 2 } }), { a: 2 });
  await assert.rejects(buildInvocation({ url: 'https://api.example.com/{path}' }, { request: true, input: { path: '../escape' } }), /inside the named resource/);
  await assert.rejects(buildInvocation({ body: '{missing}' }, { request: true, input: {} }), /needs input.missing/);
});

test('retained encoders preserve JSON, bracketed form fields, bytes and refusals', () => {
  assert.deepEqual(encodeBody({ ok: true }), { text: '{"ok":true}', content_type: 'application/json' });
  assert.equal(encodeBody({ a: ['x y', '!'], b: null }, 'form').text, 'a%5B0%5D=x+y&a%5B1%5D=%21');
  assert.deepEqual(encodeBody('AP9B', 'bytes').bytes, new Uint8Array([0, 255, 65]));
  assert.equal(encodeBody(null), null);
  assert.throws(() => encodeBody({}, 'unknown'), error => error.not_sent === true);
});

test('retained fetch fill checks public addresses and preserves fetched base64 bytes', async () => {
  const result = await buildInvocation({ fill: { from: 'input', field: 'file', fetch: 'base64' } }, { input: { file: 'https://public.example/file' }, fetchBytes: async () => new Response(new Uint8Array([0,255,65])) });
  assert.equal(result, 'AP9B');
  await assert.rejects(buildInvocation({ fill: { from: 'input', field: 'file', fetch: 'base64' } }, { input: { file: 'http://127.0.0.1/file' }, fetchBytes: () => assert.fail('private destination dispatched') }), /public site/);
});

test('retained HTTP executor adds queries, dispatches once and parses the service reply', async () => {
  const calls = [];
  const result = await httpJson({ invocation: { url: 'https://public.example/read', method: 'POST', query: { tag: ['x', 'y'], omit: null }, body: { yes: true } } }, async (url, init) => {
    calls.push({ url, init }); return new Response('{"read":true}');
  });
  assert.deepEqual(result, { read: true }); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://public.example/read?tag=x&tag=y');
  assert.equal(new TextDecoder().decode(calls[0].init.body), '{"yes":true}');
});

test('retained credential contract delegates injection and held reply storage', async () => {
  const calls = [], kept = [];
  const invocation = await buildInvocation({ url: 'https://public.example/read', connection_id: 'c', credential_injections: [{ field_id: 'key', placement: { kind: 'header', name: 'authorization' } }], reply_holds_values: [{ from: 'token.value', keep_as_field: 'key' }] }, { request: true, input: {} });
  const result = await httpJson({ invocation, send: async args => { calls.push(args); return { status_code: 200, body: '{"token":{"value":"synthetic-only"}}' }; }, keep: async (...args) => kept.push(args) }, () => assert.fail('bypassed credential owner'));
  assert.equal(calls[0].credential_injections[0].secret_name, connectionFieldName('c', 'key'));
  assert.deepEqual(kept, [[connectionFieldName('c', 'key'), 'synthetic-only']]);
  assert.deepEqual(result, { token: { value: '[held value]' } });
});
