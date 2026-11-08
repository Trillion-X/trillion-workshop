import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { hostOf, hostWithin, sharedCookieDomain } from '../do-work/same-origin.mjs';

test('host boundary checks refuse credentialed URL addresses', () => {
  for (const address of ['https://trillion.example@evil.test/', 'https://user:pass@trillion.example/']) {
    assert.equal(hostOf(address), null);
    assert.equal(hostWithin(address, 'trillion.example'), false);
    assert.equal(sharedCookieDomain(address, 'https://app.trillion.example'), null);
  }
  assert.equal(hostWithin(new URL('https://trillion.example@evil.test/'), 'trillion.example'), false);
});

test('shares only the primary address parent on a whole host-label boundary', () => {
  const primary = 'https://app.trillion.example';
  assert.equal(sharedCookieDomain(primary, primary), 'trillion.example');
  assert.equal(sharedCookieDomain('https://trillion.example', primary), 'trillion.example');
  assert.equal(sharedCookieDomain('https://www.trillion.example:8443/path', primary), 'trillion.example', 'cookie domains are host scoped, not port scoped');
  for (const outsider of [
    'https://eviltrillion.example', 'https://trillion.example.evil.test',
    'https://trillion.example@evil.test', 'https://www.customer.example', 'http://localhost:8080',
    'https://127.0.0.1', 'https://[::1]:8443',
  ]) assert.equal(sharedCookieDomain(outsider, primary), null, outsider);
  assert.equal(sharedCookieDomain('http://www.trillion.example:8080', primary), 'trillion.example', 'scheme and port do not scope Domain cookies; callers retain Secure');
});

test('supports a custom primary domain while refusing malformed and single-label primaries', () => {
  assert.equal(sharedCookieDomain('https://links.customer.example', 'https://app.customer.example:9443'), 'customer.example');
  assert.equal(sharedCookieDomain('https://app.localhost', 'https://app.localhost'), null);
  assert.equal(sharedCookieDomain('https://x.trillion.example', 'not a URL'), null);
  assert.equal(sharedCookieDomain('https://customer.example', 'https://user:pass@app.customer.example'), null);
  assert.equal(sharedCookieDomain('https://www.customer.example', 'https://app.customer.example..'), null);
});

test('a public suffix is not a shareable cookie domain, including private, wildcard and exception rules', () => {
  assert.equal(sharedCookieDomain('https://www.co.uk', 'https://app.co.uk'), null, 'ICANN suffix');
  assert.equal(sharedCookieDomain('https://tenant.github.io', 'https://app.github.io'), null, 'private hosting suffix');
  assert.equal(sharedCookieDomain('https://www.tenant.github.io', 'https://app.tenant.github.io'), 'tenant.github.io', 'tenant boundary');
  assert.equal(sharedCookieDomain('https://www.foo.ck', 'https://app.foo.ck'), null, 'wildcard suffix');
  assert.equal(sharedCookieDomain('https://www.www.ck', 'https://app.www.ck'), 'www.ck', 'PSL exception');
});

test('registrable domains are canonicalized through IDNA and IPs remain host-only', () => {
  assert.equal(sharedCookieDomain('https://www.bücher.example', 'https://app.xn--bcher-kva.example'), 'xn--bcher-kva.example');
  assert.equal(sharedCookieDomain('https://www.trillion.example', 'https://127.0.0.1'), null);
  assert.equal(sharedCookieDomain('https://www.trillion.example', 'https://[::1]:443'), null);
  assert.equal(sharedCookieDomain('https://127.0.0.1', 'https://127.0.0.1'), null);
  assert.equal(sharedCookieDomain('https://0.0.1', 'https://127.0.0.1'), null);
  assert.equal(sharedCookieDomain('https://[::1]', 'https://[::1]'), null);
});

test('the actual same-origin owner and PSL dependency bundle for a browser consumer', async () => {
  const entryPoint = fileURLToPath(new URL('../do-work/same-origin.mjs', import.meta.url));
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, platform: 'browser', format: 'esm' });
  const bundle = result.outputFiles[0].text;
  assert.match(bundle, /sharedCookieDomain/);
  assert.doesNotMatch(bundle, /from ['"]node:|require\(['"](?:node:|fs|path)/);
});
