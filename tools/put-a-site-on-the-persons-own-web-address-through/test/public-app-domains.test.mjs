import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAppDomains, publicAppDomainChallenge, publicAppDomainKey, publicAppDomainProbePath, publicAppDomainProvider } from '../src/public-app-domains.mjs';

function setup() {
  const rows = new Map();
  let dns = false;
  let serves = false;
  let attached = false;
  const provider = {
    read: async ({ host }) => ({ host, status: attached ? 'attached' : 'absent', ...(attached ? { installation_id: 'a'.repeat(32) } : {}), provider: 'mock' }),
    attach: async ({ host, installationId }) => { attached = true; return { host, installation_id: installationId }; },
    detach: async () => { attached = false; },
  };
  const storage = {
    get: async key => rows.has(key) ? JSON.parse(rows.get(key)) : null,
    put: async (key, value) => { rows.set(key, value); },
  };
  const fetcher = async (url, options) => {
    if (url.startsWith('https://cloudflare-dns.com/')) {
      assert.equal(options.redirect, 'manual');
      return Response.json({ Answer: dns ? [{ type: 16, data: '"trillion-public-app=proof-token"' }] : [] });
    }
    if (url === `https://shop.example.com${publicAppDomainProbePath}`) return new Response(serves ? 'trillion-public-app=proof-token' : 'wrong', { status: serves ? 200 : 404 });
    throw new Error(`Unexpected network request: ${url}`);
  };
  return { rows, storage, domains: publicAppDomains({ storage, fetcher, randomToken: () => 'proof-token', carrierHost: 'trillion-domain-carrier-proof.pages.dev', provider }), dns: value => { dns = value; }, serves: value => { serves = value; }, provider, attached: () => attached };
}

test('a domain stays inactive until DNS, provider attachment readback, and HTTPS carrier response all match', async () => {
  const state = setup();
  const target = { host: 'SHOP.EXAMPLE.COM', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  const claimed = await state.domains.claim(target);
  assert.deepEqual(claimed.verification_record, { type: 'TXT', name: '_trillion-verify.shop.example.com', value: 'trillion-public-app=proof-token' });
  assert.deepEqual(claimed.address_record, { type: 'CNAME', name: 'shop.example.com', value: 'trillion-domain-carrier-proof.pages.dev' });
  assert.equal((await state.domains.claim(target)).status, 'awaiting_dns');
  await assert.rejects(state.domains.claim({ ...target, ownerUserId: 'owner-b' }), /another app/);
  await assert.rejects(state.domains.activate(target), /TXT record/);
  state.dns(true);
  await assert.rejects(state.domains.activate(target), /does not reach/);
  assert.equal((await state.storage.get(publicAppDomainKey('shop.example.com'))).status, 'awaiting_attachment');
  assert.deepEqual((await state.storage.get(publicAppDomainKey('shop.example.com'))).provider_readback, { host: 'shop.example.com', status: 'attached', installation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', provider: 'mock' });
  state.serves(true);
  assert.equal((await state.domains.activate(target)).status, 'active');
  assert.equal(state.attached(), true);
  assert.equal((await state.domains.retire(target)).status, 'ended');
  assert.deepEqual((await state.storage.get(publicAppDomainKey('shop.example.com'))).provider_readback, { host: 'shop.example.com', status: 'absent', provider: 'mock' });
  assert.equal((await state.storage.get(publicAppDomainKey('shop.example.com'))).status, 'ended');
});

test('checking a live domain again keeps it serving when the provider cannot confirm', async () => {
  const state = setup();
  const target = { host: 'shop.example.com', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  await state.domains.claim(target);
  state.dns(true);
  state.serves(true);
  assert.equal((await state.domains.activate(target)).status, 'active');
  const unconfirmed = publicAppDomains({ storage: state.storage, fetcher: async url => url.startsWith('https://cloudflare-dns.com/') ? Response.json({ Answer: [{ type: 16, data: '"trillion-public-app=proof-token"' }] }) : new Response('trillion-public-app=proof-token'), provider: {
    read: async () => ({ host: target.host, status: 'pending' }),
    attach: async () => {},
    detach: async () => {},
  } });
  await assert.rejects(unconfirmed.activate(target), /provider has not confirmed/);
  assert.equal((await state.storage.get(publicAppDomainKey(target.host))).status, 'active');
  await assert.rejects(publicAppDomains({ storage: state.storage, fetcher: async () => { throw new Error("offline"); } }).activate(target));
  assert.equal((await state.storage.get(publicAppDomainKey(target.host))).status, 'active');
});

test('provider refusal or a mismatched attachment readback never activates the hostname', async () => {
  const state = setup();
  const target = { host: 'shop.example.com', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  await state.domains.claim(target);
  state.dns(true);
  const withoutProvider = publicAppDomains({ storage: state.storage, fetcher: async url => url.startsWith('https://cloudflare-dns.com/') ? Response.json({ Answer: [{ type: 16, data: '"trillion-public-app=proof-token"' }] }) : new Response('trillion-public-app=proof-token') });
  await assert.rejects(withoutProvider.activate(target), /provider is not connected/);
  assert.equal((await state.storage.get(publicAppDomainKey(target.host))).status, 'awaiting_attachment');
  const wrongOwnerProvider = {
    read: async () => ({ host: target.host, status: 'attached', installation_id: 'b'.repeat(32) }),
    attach: async () => {},
    detach: async () => {},
  };
  const wrongOwner = publicAppDomains({ storage: state.storage, fetcher: async url => url.startsWith('https://cloudflare-dns.com/') ? Response.json({ Answer: [{ type: 16, data: '"trillion-public-app=proof-token"' }] }) : new Response('trillion-public-app=proof-token'), provider: wrongOwnerProvider });
  await assert.rejects(wrongOwner.activate(target), /provider has not confirmed/);
  assert.equal((await state.storage.get(publicAppDomainKey(target.host))).status, 'awaiting_attachment');
});

test('retirement stops app and challenge responses before retryable provider detach, then ends only after absence readback', async () => {
  const state = setup();
  const target = { host: 'shop.example.com', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  await state.domains.claim(target);
  const row = await state.storage.get(publicAppDomainKey(target.host));
  row.status = 'active';
  await state.storage.put(publicAppDomainKey(target.host), JSON.stringify(row));
  const brokenProvider = { read: async () => ({ host: target.host, status: 'attached', installation_id: target.installationId }), attach: async () => {}, detach: async () => { throw new Error('provider timeout'); } };
  const retiring = publicAppDomains({ storage: state.storage, provider: brokenProvider });
  await assert.rejects(retiring.retire(target), /provider could not confirm/);
  const retiringRow = await state.storage.get(publicAppDomainKey(target.host));
  assert.equal(retiringRow.status, 'retiring');
  assert.equal(publicAppDomainChallenge(new Request(`https://${target.host}${publicAppDomainProbePath}`), retiringRow), null);
  assert.deepEqual(await state.domains.retire(target), { host: target.host, url: `https://${target.host}/`, status: 'ended', provider_readback: { host: target.host, status: 'absent', provider: 'mock' }, provider_checked_at: (await state.storage.get(publicAppDomainKey(target.host))).provider_checked_at });
});

test('challenge and retirement never serve a different installation or a retired hostname', async () => {
  const state = setup();
  const target = { host: 'shop.example.com', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  await state.domains.claim(target);
  const row = await state.storage.get(publicAppDomainKey(target.host));
  const request = new Request(`https://${target.host}${publicAppDomainProbePath}`);
  assert.equal(await publicAppDomainChallenge(request, row).text(), 'trillion-public-app=proof-token');
  await assert.rejects(state.domains.retire({ ...target, installationId: 'b'.repeat(32) }), /not connected/);
  await state.domains.retire(target);
  assert.equal(publicAppDomainChallenge(request, await state.storage.get(publicAppDomainKey(target.host))), null);
  await assert.rejects(state.domains.activate(target), /not connected/);
  await assert.rejects(state.domains.claim({ ...target, host: 'app.gettrillion.ai' }), /reserved/);
});

test('domain names normalize case and trailing dots, while rejecting URLs and reserved or numeric hosts', async () => {
  const state = setup();
  const target = { host: '  SHOP.Example.COM.  ', installationId: 'a'.repeat(32), ownerUserId: 'owner-a' };
  assert.equal((await state.domains.claim(target)).host, 'shop.example.com');
  for (const host of ['https://shop.example.com', 'shop.example.com/path', 'app.gettrillion.ai', '127.0.0.1', 'www.123']) {
    await assert.rejects(state.domains.claim({ ...target, host }), /domain|reserved/i);
  }
  assert.equal((await state.domains.claim({ ...target, host: 'shop.xn--p1ai' })).host, 'shop.xn--p1ai');
});

test('only the operator can prove a spare Trillion-owned subdomain; service addresses stay reserved', async () => {
  const state = setup();
  const domains = publicAppDomains({ storage: state.storage, operatorUserId: 'operator', randomToken: () => 'operator-proof' });
  const input = { host: 'domain-lifecycle.gettrillion.ai', installationId: 'a'.repeat(32), ownerUserId: 'operator' };
  assert.equal((await domains.claim(input)).status, 'awaiting_dns');
  await assert.rejects(domains.claim({ ...input, host: 'app.gettrillion.ai' }), /reserved/);
  await assert.rejects(domains.claim({ ...input, host: 'harness.gettrillion.ai' }), /reserved/);
  await assert.rejects(domains.claim({ ...input, host: 'gettrillion.ai' }), /reserved/);
  await assert.rejects(domains.claim({ ...input, host: 'another.gettrillion.ai', ownerUserId: 'customer' }), /reserved/);
});

test('the provider adapter uses only its owner service binding and preserves provider readback', async () => {
  const calls = [];
  const provider = publicAppDomainProvider({ fetch: async request => {
    const body = await request.json();
    const action = new URL(request.url).pathname.slice(1);
    calls.push({ action, body });
    return Response.json({ result: { host: body.host, status: action === 'read' ? 'attached' : 'ok', installation_id: body.installationId } });
  } });
  const input = { host: 'shop.example.com', installationId: 'a'.repeat(32), carrierHost: 'carrier.example.net' };
  await provider.attach(input);
  assert.deepEqual(await provider.read(input), { host: input.host, status: 'attached', installation_id: input.installationId });
  await provider.detach(input);
  assert.deepEqual(calls.map(call => call.action), ['attach', 'read', 'detach']);
  assert.deepEqual(calls[0].body, input);
  assert.equal(publicAppDomainProvider(null), null);
});
