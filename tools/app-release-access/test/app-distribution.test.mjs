// The public projection tests are moved from old trillion test/device-distribution.test.mjs (the account-side
// management, install-way and refresh tests stay with the engine's owner of device distribution). The read tool and
// the held-key client are new tests: old trillion had none for computer/app-distribution.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import settings from '../read-data/distribution.json' with { type: 'json' };
import { distributionObservation, distributionSource } from '../read-data/distribution.mjs';
import { makeAppDistributionTools, read } from '../read-data/app-distribution.mjs';
import { appStoreConnect, heldKey } from '../read-data/app-store-connect.mjs';

const now = Date.parse('2026-10-08T06:00:00Z');
const source = distributionSource('native-ios');
const iso = value => new Date(value).toISOString();
const route = (overrides = {}) => ({ id: 'testflight-public:g1:old', channel: 'public_link', build_id: 'old', group_id: 'g1', state: 'unknown', distribution_state: 'ready', eligibility_state: 'unknown', reason: 'The device has not been checked.', expires_at: iso(now + 300000), evidence: { public_link: 'https://testflight.apple.com/join/AbC123' }, eligibility_requirements: { known: true, alternatives: [{ device_family: null, minimum_os: '18.0', maximum_os: null }] }, ...overrides });
const observation = (overrides = {}) => ({ checked_at: iso(now), expires_at: iso(now + 300000), routes: [route()], ...overrides });

test('the public projection keeps only safe data and never includes tester identities or arbitrary provider payloads', () => {
  const privateReport = observation({ tester_email: 'private@example.invalid', api_key: 'secret', routes: [route({ tester_id: 'private-tester', tester: { email: 'private@example.invalid' }, evidence: { public_link: 'https://testflight.apple.com/join/AbC123', tester_email: 'private@example.invalid' } })] });
  const safe = distributionObservation(source, privateReport, now);
  assert.equal(safe.source_id, 'native-ios');
  assert.equal(safe.routes[0].check.href, 'https://testflight.apple.com/join/AbC123');
  assert.equal(safe.routes[0].build_id, 'old');
  assert.equal(safe.routes[0].action, undefined);
  assert.ok(!JSON.stringify(safe).includes('private'));
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.throws(() => distributionObservation(source, observation({ routes: [route({ channel: 'email' })] }), now), /private or unconfigured/);
});

test('source identity, route identity, safe HTTPS destination and bounded clock window are required', () => {
  assert.throws(() => distributionObservation(null, observation(), now), /configured/);
  assert.throws(() => distributionObservation(source, observation({ routes: [route(), route()] }), now), /distinct/);
  assert.throws(() => distributionObservation(source, observation({ routes: Array.from({ length: settings.max_routes + 1 }, (_, i) => route({ id: String(i) })) }), now), /bounded list/);
  for (const href of ['http://testflight.apple.com/join/abc', 'https://testflight.apple.com.evil.invalid/join/abc', 'https://user:user-df51bfcd@example.com/join/abc', 'javascript:alert(1)']) {
    assert.throws(() => distributionObservation(source, observation({ routes: [route({ state: 'ready', action: { href } })] }), now), /destination/);
  }
  for (const invalid of [
    { checked_at: 'not-a-date' }, { expires_at: iso(now) }, { expires_at: iso(now + 301000) },
    { checked_at: iso(now + 16000), expires_at: iso(now + 300000) },
    { routes: [route({ expires_at: iso(now + 300001) })] },
  ]) assert.throws(() => distributionObservation(source, observation(invalid), now));
});

const BUNDLE = 'com.example.sample';
const asc = (apps = [{ id: 'app-one', attributes: { bundleId: BUNDLE } }]) => ({ calls: [], async get(path, options) { this.calls.push({ path, options }); return { data: apps }; } });

test('the read answers the safe observation of the one app named and never publishes', async () => {
  const client = asc();
  const tools = makeAppDistributionTools({ connect: () => client, readKey: () => ({}), now: () => now,
    readAvailability: async ({ appId, testflight }) => { assert.equal(appId, 'app-one'); assert.deepEqual(testflight.groups, ['Members']); return observation({ tester_email: 'private@example.invalid' }); } });
  const answer = await tools.read({ source_id: 'native-ios', bundle_identifier: BUNDLE, testflight_groups: ['Members'] });
  assert.equal(answer.source_id, 'native-ios');
  assert.equal(answer.published, null);
  assert.equal(answer.observation.routes[0].check.href, 'https://testflight.apple.com/join/AbC123');
  assert.ok(!JSON.stringify(answer).includes('private'));
  assert.deepEqual(client.calls[0].options.query, { 'filter[bundleId]': BUNDLE, limit: 2 });
});

test('the read refuses an unconfigured source, tester input, a missing app and publishing before reaching Apple', async () => {
  let connected = 0;
  const tools = makeAppDistributionTools({ connect: () => { connected++; return asc(); }, readKey: () => ({}), readAvailability: async () => observation(), now: () => now });
  await assert.rejects(tools.read({ source_id: 'other', bundle_identifier: BUNDLE }), /configured installation source/);
  await assert.rejects(tools.read({ source_id: 'native-ios', bundle_identifier: BUNDLE, tester_email: 'a@example.test' }), /private tester input/);
  await assert.rejects(tools.read({ source_id: 'native-ios' }), /bundle identifier/);
  await assert.rejects(tools.read({ source_id: 'native-ios', bundle_identifier: BUNDLE, publish: 'yes' }), /true or false/);
  await assert.rejects(tools.read({ source_id: 'native-ios', bundle_identifier: BUNDLE, publish: true }), /workspace:write/);
  assert.equal(connected, 0);
  await assert.rejects(read({ source_id: 'native-ios', bundle_identifier: BUNDLE }), /No App Store Connect team key/);
});

test('an ambiguous or paged Apple app answer is refused', async () => {
  for (const apps of [[], [{ id: 'a', attributes: { bundleId: BUNDLE } }, { id: 'b', attributes: { bundleId: BUNDLE } }]]) {
    const tools = makeAppDistributionTools({ connect: () => asc(apps), readKey: () => ({}), readAvailability: async () => observation(), now: () => now });
    await assert.rejects(tools.read({ source_id: 'native-ios', bundle_identifier: BUNDLE }), /one complete Apple app record/);
  }
});

test('the client signs an ES256 token from the held key, stays on App Store Connect and keeps Apple\'s body out of errors', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => heldKey(''), /No App Store Connect team key/);
  assert.throws(() => heldKey(JSON.stringify({ key_id: 'K', issuer_id: 'I', private_key: 'not a key' })), /\.p8/);
  const key = heldKey(JSON.stringify({ key_id: 'SAMPLEKEY', issuer_id: 'sample-issuer', private_key: pem }));
  const seen = [];
  const client = appStoreConnect({ apiKey: key, fetcher: async (url, options) => {
    seen.push({ url: String(url), auth: options.headers.Authorization, redirect: options.redirect });
    return String(url).includes('fail') ? new Response('{"errors":[{"detail":"tester private@example.invalid"}]}', { status: 409 }) : Response.json({ data: [] });
  } });
  assert.deepEqual(await client.get('/v1/apps', { query: { limit: 2 } }), { data: [] });
  assert.equal(seen[0].url, 'https://api.appstoreconnect.apple.com/v1/apps?limit=2');
  assert.equal(seen[0].redirect, 'error');
  const [header, payload, signature] = seen[0].auth.slice('Bearer '.length).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'SAMPLEKEY', typ: 'JWT' });
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'sample-issuer');
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  await assert.rejects(client.get('https://example.test/v1/apps'), /stay on App Store Connect/);
  const failure = await client.get('/v1/fail').catch(error => error);
  assert.equal(failure.status, 409);
  assert.ok(!failure.message.includes('private@'));
});
