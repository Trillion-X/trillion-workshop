import test from 'node:test';
import assert from 'node:assert/strict';
import { proxied } from '../launch.mjs';

test('a run told a proxy sends the browser through it, loopback included', () => {
  assert.deepEqual(proxied({ headless: true }, { HTTPS_PROXY: 'http://127.0.0.1:8787' }),
    { headless: true, proxy: { server: 'http://127.0.0.1:8787', bypass: '<-loopback>' } });
  assert.deepEqual(proxied({}, { https_proxy: 'http://127.0.0.1:9' }).proxy.server, 'http://127.0.0.1:9');
});

test('no proxy told, or one already named, leaves the options as they are', () => {
  assert.deepEqual(proxied({ headless: true }, {}), { headless: true });
  const own = { proxy: { server: 'http://own:1' } };
  assert.equal(proxied(own, { HTTPS_PROXY: 'http://127.0.0.1:8787' }), own);
});
