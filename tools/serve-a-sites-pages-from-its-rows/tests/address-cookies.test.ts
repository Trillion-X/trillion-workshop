// A value the arrival address carries (?ref=CODE) is kept as a cookie by any GET, the site's own pages and a passed-on
// program's alike, only when it is the whole of its pattern, with the site's domain on the site's own hosts. Synthetic codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { addressCookiesOf, cookiesFromAddress, withCookies } from '../do-work/address-cookies.ts';
import { handlerOf, settingsOf } from '../do-work/serve.ts';
import type { Site } from '../do-work/serve.ts';

const REF = { query: 'ref', cookie: 'site_ref', pattern: '[A-Z0-9][A-Z0-9-]{3,31}', upper_case: true, max_age_days: 30, domain: 'example.com' };

test('a code in the address is kept upper-cased for 30 days, on the site\'s domain only for its own hosts', () => {
  const rules = addressCookiesOf([REF]);
  assert.deepEqual(cookiesFromAddress(rules, 'GET', '/?ref=ab12-cd', 'example.com'), ['site_ref=AB12-CD; Max-Age=2592000; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly']);
  assert.deepEqual(cookiesFromAddress(rules, 'GET', '/courses?x=1&ref=AB12CD', 'app.example.com'), ['site_ref=AB12CD; Max-Age=2592000; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly'], 'a host under the domain shares it');
  assert.deepEqual(cookiesFromAddress(rules, 'HEAD', '/?ref=AB12CD', 'preview.test'), ['site_ref=AB12CD; Max-Age=2592000; Path=/; SameSite=Lax; Secure; HttpOnly'], 'another host keeps it for itself');
  assert.deepEqual(cookiesFromAddress(addressCookiesOf([{ ...REF, http_only: false }]), 'GET', '/?ref=AB12CD', 'example.com')[0].endsWith('Secure'), true, 'http_only false leaves HttpOnly off');
});

test('a value that is not the whole pattern, a POST, or no value keeps nothing', () => {
  const rules = addressCookiesOf([REF]);
  for (const url of ['/', '/?ref=', '/?ref=AB1', '/?ref=AB12CD%3B%20Domain%3Devil.test', '/?ref=AB12CD%0d%0aX:1', `/?ref=${'A'.repeat(33)}`, '/?ref=-AB12CD']) {
    assert.deepEqual(cookiesFromAddress(rules, 'GET', url, 'example.com'), [], url);
  }
  assert.deepEqual(cookiesFromAddress(rules, 'POST', '/?ref=AB12CD', 'example.com'), []);
  assert.deepEqual(cookiesFromAddress(addressCookiesOf([{ ...REF, pattern: '.+' }]), 'GET', '/?ref=a%3Bb', 'example.com'), [], 'whatever the pattern, a value is only cookie-safe characters');
});

test('rules are checked when the settings are read', () => {
  for (const bad of [{}, [{ ...REF, cookie: 'a b' }], [{ ...REF, pattern: '(' }], [{ ...REF, max_age_days: 0 }], [{ ...REF, domain: 'Example.com' }], [{ ...REF, upper_case: 'yes' }]]) {
    assert.throws(() => addressCookiesOf(bad), /address_cookies/, JSON.stringify(bad));
  }
  assert.deepEqual(addressCookiesOf(undefined), []);
  const settings = settingsOf({
    listen: '127.0.0.1:0', origin: 'https://example.com', lang: 'en', door: { address: 'http://127.0.0.1:1', pass_credential: 'p' },
    pages: { database: 'a_site', refresh_seconds: 60, answer_seconds: 0 },
    sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://example.com', audience: 'https://example.com', team_claim: 't', members_team: 'm' },
    address_cookies: [REF],
  });
  assert.deepEqual(settings.address_cookies, [REF]);
  assert.deepEqual(withCookies({ 'set-cookie': 'a=1' }, ['b=2']), { 'set-cookie': ['a=1', 'b=2'] }, 'a cookie the answer sets is kept beside');
});

test('over node:http the cookie rides on the site\'s own page and on a passed-on program\'s answer, beside its own cookies', async () => {
  const other = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'theirs=1; Path=/' }); response.end('theirs'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  // A stand-in site: no action rows, no page rows under the passed-on path, and one plain answer of its own.
  const site = {
    hostOf: () => 'example.com', acts: () => false, pageFor: () => null, siteHead: null,
    answer: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ours' }),
  } as unknown as Site;
  const server = http.createServer(handlerOf(site, [{ name: 'other', address: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, paths: ['/old'] }], addressCookiesOf([REF])));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ours = await fetch(`${at}/?ref=ab12cd`);
    assert.equal(await ours.text(), 'ours');
    assert.deepEqual(ours.headers.getSetCookie(), ['site_ref=AB12CD; Max-Age=2592000; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly']);
    const theirs = await fetch(`${at}/old/page?ref=AB12CD`);
    assert.equal(await theirs.text(), 'theirs');
    assert.deepEqual(theirs.headers.getSetCookie(), ['theirs=1; Path=/', 'site_ref=AB12CD; Max-Age=2592000; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly']);
    assert.deepEqual((await fetch(`${at}/`)).headers.getSetCookie(), [], 'no code, no cookie');
  } finally { server.close(); other.close(); }
});
