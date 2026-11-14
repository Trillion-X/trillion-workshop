// tools/better-auth-official/test/attached-origins.test.mjs
//
// Every domain an account attaches signs people in with no settings edit: Better Auth's trusted origins (its documented
// function form) answer the request's origin when the verified origins rows name its host (the certificate ask the front
// door already uses: 200 only when one live account names the host), and nothing else; the passkey related origins
// document (/.well-known/webauthn) lists the home origin and the verified origins the related list answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedOrigins, trustedOriginsFor } from '../attached-origins.mjs';

const settings = {
  trusted_origins: ['https://app.example.test'],
  attached_origins: { ask_url: 'http://127.0.0.1:9444/origins/certificate', cache_ms: 60000, related_url: 'http://127.0.0.1:9444/origins/related' },
};
const verified = new Set(['shop.example.org', 'www.shop.example.org']);
const asked = [];
const fetchImpl = async url => {
  asked.push(url);
  const { pathname, searchParams } = new URL(url);
  if (pathname === '/origins/certificate') return { ok: verified.has(searchParams.get('domain')), status: verified.has(searchParams.get('domain')) ? 200 : 404 };
  if (pathname === '/origins/related') return { ok: true, status: 200, json: async () => ({ origins: [...verified].sort().map((host, revision) => ({ origin: `https://${host}`, revision: revision + 1 })) }) };
  return { ok: false, status: 404 };
};
const request = origin => new Request('https://app.example.test/api/auth/sign-up/email', { method: 'POST', headers: origin ? { origin } : {} });

test('with no request the home origins are trusted, as the docs say to answer then', async () => {
  const trusted = trustedOriginsFor(settings, { fetchImpl });
  assert.deepEqual(await trusted(undefined), ['https://app.example.test']);
});

test('a request from a verified attached origin is trusted with no settings edit; an unverified one is not', async () => {
  const trusted = trustedOriginsFor(settings, { fetchImpl });
  assert.deepEqual(await trusted(request('https://shop.example.org')), ['https://app.example.test', 'https://shop.example.org']);
  assert.deepEqual(await trusted(request('https://not-attached.example.net')), ['https://app.example.test']);
});

test('only an https origin with no port and no path is asked about; the answer is kept for cache_ms', async () => {
  let now = 0;
  const trusted = trustedOriginsFor(settings, { fetchImpl, now: () => now });
  asked.length = 0;
  for (const origin of ['http://shop.example.org', 'https://shop.example.org:8443', 'null', 'https://shop.example.org/path']) {
    assert.deepEqual(await trusted(request(origin)), ['https://app.example.test'], origin);
  }
  assert.equal(asked.length, 0, 'none of those is asked about');
  await trusted(request('https://www.shop.example.org'));
  await trusted(request('https://www.shop.example.org'));
  assert.equal(asked.length, 1, 'a second request inside cache_ms is answered from the cache');
  now = 60001;
  await trusted(request('https://www.shop.example.org'));
  assert.equal(asked.length, 2, 'after cache_ms the rows are asked again');
});

test('the related origins document lists the home origin and every verified origin, and only the home origin when no list answers', async () => {
  assert.deepEqual(await relatedOrigins(settings, { fetchImpl }), { origins: ['https://app.example.test', 'https://shop.example.org', 'https://www.shop.example.org'] });
  assert.deepEqual(await relatedOrigins({ ...settings, attached_origins: { ...settings.attached_origins, related_url: null } }, { fetchImpl }), { origins: ['https://app.example.test'] });
  assert.deepEqual(await relatedOrigins(settings, { fetchImpl: async () => { throw new Error('down'); } }), { origins: ['https://app.example.test'] });
});
