// test/http-client-executor.test.mjs
//
// The Postman findings as Trillion mechanisms (parts/http-client/do-work): ordered variable scopes with unresolved names left
// visible and secrets bound to hosts (F-0802, F-0803), and the address a name resolves to judged at connect time with CIDR
// ranges (F-0804).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequest, scrubValues } from '../do-work/request-scopes.mjs';
import { NameNotFound, checkedLookup, inRanges, resolvePublic } from '../do-work/resolved-address.mjs';

test('the first scope holding a name wins, unknown names stay visible, and the stored template is not changed', () => {
  const template = { url: 'https://api.example.com/{{path}}', headers: { a: '{{who}}', b: '{{missing}}' }, body: '{{who}}-{{id}}' };
  const kept = structuredClone(template);
  const answer = resolveRequest(template, { scopes: [{ name: 'local', values: { who: 'local-who' } }, { name: 'global', values: { who: 'global-who', path: 'v1', id: '7' } }] });
  assert.deepEqual(answer.request, { url: 'https://api.example.com/v1', headers: { a: 'local-who', b: '{{missing}}' }, body: 'local-who-7' });
  assert.deepEqual(answer.unresolved, ['missing']);
  assert.deepEqual(template, kept);
});

test('a secret is placed only on a host it is bound to, judged on the written and the resolved address, and never moves the request', () => {
  const secret = { name: 'token', value: 'S3CR3T-VALUE', hosts: ['example.com'] };
  const ok = resolveRequest({ url: 'https://api.example.com/x', headers: { authorization: 'Bearer {{token}}' } }, { secrets: [secret] });
  assert.equal(ok.request.headers.authorization, 'Bearer S3CR3T-VALUE');
  assert.deepEqual(ok.placed, ['token']);
  const elsewhere = resolveRequest({ url: 'https://evil.test/x', headers: { authorization: 'Bearer {{token}}' } }, { secrets: [secret] });
  assert.equal(elsewhere.request.headers.authorization, 'Bearer {{token}}');
  assert.match(elsewhere.refused[0].why, /bound to example\.com and the request goes to evil\.test/);
  // The written address is a look-alike inside the bound domain only after a variable is resolved: both are judged.
  const sneaky = resolveRequest({ url: 'https://example.com.evil.test/x', headers: { a: '{{token}}' } }, { secrets: [secret] });
  assert.equal(sneaky.placed.length, 0);
  const viaVariable = resolveRequest({ url: 'https://{{host}}/x', headers: { a: '{{token}}' } }, { scopes: [{ name: 'environment', values: { host: 'evil.test' } }], secrets: [secret] });
  assert.equal(viaVariable.placed.length, 0);
  const inUrl = resolveRequest({ url: 'https://user:{{token}}@api.example.com/' }, { secrets: [{ ...secret, value: 'x@evil.test/' }] });
  assert.equal(inUrl.placed.length, 0, 'placing the secret would move the request');
  assert.match(inUrl.refused.at(-1).why, /change where the request goes/);
  // A variable named like a secret cannot shadow it: secrets are the last scope, so a scope value wins only for ordinary names.
  const shadow = resolveRequest({ url: 'https://api.example.com/', headers: { a: '{{token}}' } }, { scopes: [{ name: 'local', values: { token: 'ordinary' } }], secrets: [secret] });
  assert.equal(shadow.request.headers.a, 'ordinary');
});

test('secret values are masked in what is kept, except the response, whose echoes this layer does not cover', () => {
  const event = { request: { headers: { a: 'Bearer S3CR3T-VALUE' } }, log: ['sent S3CR3T-VALUE'], response: { body: 'echo S3CR3T-VALUE' } };
  assert.deepEqual(scrubValues(event, ['S3CR3T-VALUE']), { request: { headers: { a: 'Bearer [held value]' } }, log: ['sent [held value]'], response: { body: 'echo S3CR3T-VALUE' } });
});

test('a name that resolves to a private address is refused like a name that does not exist, for every answer, with CIDR ranges and opt-in deny', async () => {
  const answers = { 'fine.example.com': [{ address: '93.184.216.34', family: 4 }], 'rebinds.example.com': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'meta.example.com': [{ address: '169.254.169.254', family: 4 }], 'six.example.com': [{ address: '::ffff:10.0.0.1', family: 6 }], 'odd.example.com': [{ address: '8.8.8.8', family: 4 }] };
  const resolve = async host => { if (!answers[host]) throw new Error('nope'); return answers[host]; };
  assert.equal((await resolvePublic('fine.example.com', resolve))[0].address, '93.184.216.34');
  const messages = [];
  for (const host of ['rebinds.example.com', 'meta.example.com', 'six.example.com', 'localhost', 'missing.example.com']) {
    await assert.rejects(resolvePublic(host, resolve), error => { assert.ok(error instanceof NameNotFound); assert.equal(error.code, 'ENOTFOUND'); messages.push(error.message.replace(host, 'H')); return true; });
  }
  assert.equal(new Set(messages).size, 1, 'one indistinguishable text');
  await assert.rejects(resolvePublic('odd.example.com', resolve, { deny: ['8.8.8.0/24'] }), NameNotFound);
  assert.equal(inRanges('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(inRanges('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(inRanges('fc12::1', ['fc00::/7']), true);
  assert.equal(inRanges('fe80::1', ['fc00::/7', '10.0.0.0/8']), false);
  const lookup = checkedLookup(resolve);
  assert.deepEqual(await new Promise(done => lookup('fine.example.com', {}, (error, address, family) => done([error, address, family]))), [null, '93.184.216.34', 4]);
  assert.equal((await new Promise(done => lookup('fine.example.com', { all: true }, (error, list) => done(list)))).length, 1);
  assert.equal((await new Promise(done => lookup('meta.example.com', {}, error => done(error)))).code, 'ENOTFOUND');
});
