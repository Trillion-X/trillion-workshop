import test from 'node:test';
import assert from 'node:assert/strict';
import { makeShareLinkRouting, normalizeShareDomain, normalizeSharePath } from '../src/share-link-routing.mjs';

const kv = () => {
  const values = new Map();
  return { values, get: async (key, type) => { const value = values.get(key); return type === 'json' && value ? JSON.parse(value) : value ?? null; }, put: async (key, value) => values.set(key, value) };
};

function router({ txt = () => [], targetUrl = target => `https://app.gettrillion.ai/share/${target.id}` } = {}) {
  const storage = kv();
  let suffix = 0;
  const routes = makeShareLinkRouting({
    storage,
    checkTxt: txt,
    resolveTarget: async target => targetUrl(target),
    random: size => Uint8Array.from({ length: size }, () => ++suffix),
  });
  return { storage, routes };
}

test('domain and path inputs are canonical and reject authority/path confusion', () => {
  assert.equal(normalizeShareDomain('SHOP.Example.com.'), 'shop.example.com');
  assert.equal(normalizeShareDomain('bücher.example'), 'xn--bcher-kva.example');
  assert.throws(() => normalizeShareDomain('https://shop.example'), /without a scheme/);
  assert.throws(() => normalizeShareDomain('app.gettrillion.ai'), /reserved/);
  assert.equal(normalizeSharePath('/contracts//sam/'), '/contracts/sam');
  for (const path of ['contracts/sam', '//other.example/x', '/x?y=1', '/x#frag', '/a/../b', '/x%2f..%2fy']) assert.throws(() => normalizeSharePath(path));
});

test('a domain needs its own DNS proof and trusted Cloudflare attachment before aliases resolve', async () => {
  let dns = [];
  const { routes } = router({ txt: async (_host, recordName) => { assert.equal(recordName, '_trillion-verify.shop.example'); return dns; } });
  const claimed = await routes.claimDomain('account-a', 'shop.example');
  assert.equal(claimed.status, 'awaiting_dns');
  assert.equal(claimed.verification_record.type, 'TXT');
  await assert.rejects(routes.addRoute('account-a', 'shop.example', { path: '/offer', target: { kind: 'contract', id: 'contract-1' } }), /verified and connected/);
  assert.equal((await routes.verifyDomain('account-a', 'shop.example')).verified, false);
  dns = [claimed.verification_record.value];
  const verified = await routes.verifyDomain('account-a', 'shop.example');
  assert.equal(verified.status, 'awaiting_attachment');
  assert.equal(await routes.resolve(new Request('https://shop.example/offer')), null);
  await routes.setAttached('shop.example', true);
  const created = await routes.addRoute('account-a', 'shop.example', { path: '/offer', target: { kind: 'contract', id: 'contract-1' } });
  assert.equal(created.address, 'https://shop.example/offer');
  const response = await routes.resolve(new Request(created.address));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://app.gettrillion.ai/share/contract-1');
  await routes.setAttached('shop.example', false);
  assert.equal(await routes.resolve(new Request(created.address)), null);
});

test('one domain supports multiple customer paths, random template paths and isolated ownership', async () => {
  const { routes } = router({ txt: async (_host, name) => [`trillion-domain-verification=${tokenByDomain.get(name)}`] });
  const claimed = await routes.claimDomain('account-a', 'sales.example');
  tokenByDomain.set('_trillion-verify.sales.example', claimed.verification_record.value.slice('trillion-domain-verification='.length));
  await routes.verifyDomain('account-a', 'sales.example');
  await routes.setAttached('sales.example', true);
  const first = await routes.addRoute('account-a', 'sales.example', { path: '/casey', target: { kind: 'contract', id: 'casey' } });
  const second = await routes.addRoute('account-a', 'sales.example', { path: '/morgan', target: { kind: 'checkout', id: 'morgan' } });
  const generated = await routes.addRoute('account-a', 'sales.example', { template: '/c/{random}', target: { kind: 'contract', id: 'generated' } });
  assert.notEqual(first.address, second.address);
  assert.match(generated.address, /^https:\/\/sales\.example\/c\/[0-9a-f]{24}$/);
  assert.equal((await routes.resolve(new Request(first.address))).headers.get('location'), 'https://app.gettrillion.ai/share/casey');
  assert.equal((await routes.resolve(new Request(second.address))).headers.get('location'), 'https://app.gettrillion.ai/share/morgan');
  const changed = await routes.changeRoute('account-a', 'sales.example', '/casey', { path: '/casey/signed-copy', target: { kind: 'contract', id: 'casey-final' } });
  assert.equal(changed.address, 'https://sales.example/casey/signed-copy');
  assert.equal(await routes.resolve(new Request(first.address)), null);
  assert.equal((await routes.resolve(new Request(changed.address))).headers.get('location'), 'https://app.gettrillion.ai/share/casey-final');
  await assert.rejects(routes.changeRoute('account-a', 'sales.example', '/casey/signed-copy', { path: '/morgan' }), /already in use/);
  await assert.rejects(routes.claimDomain('account-b', 'sales.example'), /another account/);
  await assert.rejects(routes.removeRoute('account-b', 'sales.example', '/casey/signed-copy'), /not connected to this account/);
  await routes.removeRoute('account-a', 'sales.example', '/casey/signed-copy');
  assert.equal(await routes.resolve(new Request(changed.address)), null);
});

const tokenByDomain = new Map();
