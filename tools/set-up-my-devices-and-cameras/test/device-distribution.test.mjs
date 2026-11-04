import assert from 'node:assert/strict';
import { test } from 'node:test';
import settings from '../src/devices.json' with { type: 'json' };
import { workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';
import { distributionObservation, distributionRecordLabel, distributionSource, manageDeviceDistribution, observedInstallWays, readDeviceDistribution, routeEligibility } from '../src/device-distribution.mjs';

const now = Date.parse('2026-10-08T06:00:00Z');
const source = distributionSource('native-ios');
const entry = settings.devices.find(device => device.id === 'iphone').get[0];
const observer = { device_family: 'IPHONE', os_version: '18.0' };
const iso = value => new Date(value).toISOString();
const route = (overrides = {}) => ({ id: 'testflight-public:g1:old', channel: 'public_link', build_id: 'old', group_id: 'g1', state: 'unknown', distribution_state: 'ready', eligibility_state: 'unknown', reason: 'The device has not been checked.', expires_at: iso(now + 300000), evidence: { public_link: 'https://testflight.apple.com/join/AbC123' }, eligibility_requirements: { known: true, alternatives: [{ device_family: null, minimum_os: '18.0', maximum_os: null }] }, ...overrides });
const observation = (overrides = {}) => ({ checked_at: iso(now), expires_at: iso(now + 300000), routes: [route()], ...overrides });
const distribution = value => ({ 'native-ios': value });
const put = body => new Request('https://app.example/mcp/api/device-distribution', { method: 'PUT', body: JSON.stringify(body) });

function owner(initial = null, options = {}) {
  let record = structuredClone(initial);
  const writes = [], reads = [], work = [];
  return {
    writes, reads, work,
    value: () => structuredClone(record),
    operator: {
      async workspaceRecord(label) { reads.push(label); if (options.readError) throw new Error('unavailable'); return structuredClone(record); },
      async putWorkspaceRecords(changes) {
        writes.push(changes);
        if (options.conflict) return { ok: false, conflicts: [{ address_label: changes[0].address_label }] };
        const expected = record === null ? null : workspaceValueIdentity(record);
        if (changes[0].expected_identity !== expected) return { refused: true };
        if (!options.noSave) record = structuredClone(changes[0].payload);
        return { ok: true };
      },
      async runTool(origin, request) { assert.equal(origin, 'device-distribution'); work.push(request); return { task_id: 'existing-workshop-job', state: 'queued' }; },
    },
  };
}
const manage = (request, o, extra = {}) => manageDeviceDistribution(request, { operator: o.operator, operatorId: 'release-owner', userId: 'release-owner', now, ...extra });

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
  assert.throws(() => distributionObservation(source, observation({ routes: Array.from({ length: settings.distribution.max_routes + 1 }, (_, i) => route({ id: String(i) })) }), now), /bounded list/);
  for (const href of ['http://testflight.apple.com/join/abc', 'https://testflight.apple.com.evil.invalid/join/abc', 'https://user:user-df51bfcd@example.com/join/abc', 'javascript:alert(1)']) {
    assert.throws(() => distributionObservation(source, observation({ routes: [route({ state: 'ready', action: { href } })] }), now), /destination/);
  }
  for (const invalid of [
    { checked_at: 'not-a-date' }, { expires_at: iso(now) }, { expires_at: iso(now + 301000) },
    { checked_at: iso(now + 16000), expires_at: iso(now + 300000) },
    { routes: [route({ expires_at: iso(now + 300001) })] },
  ]) assert.throws(() => distributionObservation(source, observation(invalid), now));
});

test('verified distribution and a matching observed device offer installation while missing, stale and incompatible data do not', () => {
  const current = distribution(observation());
  const [ready] = observedInstallWays(entry, current, now, observer);
  assert.equal(ready.available, true);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.href, 'https://testflight.apple.com/join/AbC123');
  const [unobserved] = observedInstallWays(entry, current, now);
  assert.equal(unobserved.available, null);
  assert.equal(unobserved.href, null);
  assert.equal(unobserved.recovery.href, ready.href);
  assert.match(unobserved.recovery.label, /Check/);
  const [wrongOs] = observedInstallWays(entry, current, now, { ...observer, os_version: '17.9' });
  assert.equal(wrongOs.available, false);
  assert.equal(wrongOs.href, null);
  assert.equal(wrongOs.recovery, undefined);
  for (const value of [null, {}, distribution(observation({ expires_at: iso(now + 300000) }))]) {
    const at = value?.['native-ios'] ? now + 300000 : now;
    const [unknown] = observedInstallWays(entry, value, at, observer);
    assert.equal(unknown.available, null);
    assert.equal(unknown.href, null);
  }
  const [routeExpired] = observedInstallWays(entry, distribution(observation({ routes: [route({ expires_at: iso(now + 1000) })] })), now + 1000, observer);
  assert.equal(routeExpired.available, null);
  assert.equal(routeExpired.href, null);
});

test('public eligibility is a numeric OR over scoped alternatives, and unknown hardware is never assumed eligible', () => {
  const restricted = distributionObservation(source, observation({ routes: [route({ eligibility_requirements: { known: true, alternatives: [{ device_family: 'IPHONE', minimum_os: '18.2', maximum_os: '18.10' }] } })] }), now).routes[0];
  assert.equal(routeEligibility(source, restricted, { ...observer, os_version: '18.10' }), 'ready');
  assert.equal(routeEligibility(source, restricted, { ...observer, os_version: '18.11' }), 'blocked');
  assert.equal(routeEligibility(source, restricted, { ...observer, os_version: null }), 'unknown');
  assert.notEqual(routeEligibility(source, restricted, { device_family: 'IPAD', os_version: '18.5' }), 'ready');
  assert.notEqual(routeEligibility(source, restricted, null), 'ready');
  assert.equal(routeEligibility(source, { ...restricted, eligibility_requirements: { known: false, alternatives: [] } }, observer), 'unknown');
});

test('malformed or unsafe numeric OS segments cannot manufacture eligibility', () => {
  const unknown = route({ eligibility_requirements: { known: true, alternatives: [{ device_family: 'IPHONE', minimum_os: '9007199254740993', maximum_os: null }] } });
  let safe;
  try { safe = distributionObservation(source, observation({ routes: [unknown] }), now); } catch { return; }
  assert.notEqual(routeEligibility(source, safe.routes[0], { device_family: 'IPHONE', os_version: '9007199254740992' }), 'ready');
});

test('older usable build routes remain available while newer incompatible or unverified routes stay separate', () => {
  const newer = route({ id: 'testflight-public:g1:new', build_id: 'new', eligibility_requirements: { known: true, alternatives: [{ device_family: null, minimum_os: '26.0', maximum_os: null }] } });
  const unchecked = route({ id: 'testflight-public:g1:unverified', build_id: null, distribution_state: 'unknown', eligibility_requirements: { known: false, alternatives: [] } });
  const ways = observedInstallWays(entry, distribution(observation({ routes: [newer, route(), unchecked] })), now, observer);
  assert.equal(ways.find(way => way.route_id.endsWith(':old')).available, true);
  assert.equal(ways.find(way => way.route_id.endsWith(':new')).available, false);
  assert.equal(ways.find(way => way.route_id.endsWith(':unverified')).available, null);
});

test('management refuses customer writes before reading owner data, even if they know an identity', async () => {
  const o = owner();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const request = new Request('https://app.example/mcp/api/device-distribution?source_id=native-ios', { method, ...(method !== 'GET' ? { body: JSON.stringify({ source_id: 'native-ios', observation: observation(), expected_identity: null }) } : {}) });
    assert.equal((await manage(request, o, { userId: 'customer' })).status, 403);
  }
  assert.equal(o.reads.length, 0);
  assert.equal(o.writes.length, 0);
});

test('management rejects malformed envelopes, excessive input and unsupported methods without a write', async () => {
  const o = owner();
  for (const body of ['null', '[]', '42', '"text"', '{']) {
    const request = new Request('https://app.example/mcp/api/device-distribution?source_id=native-ios', { method: 'PUT', body });
    assert.equal((await manage(request, o)).status, 400, body);
  }
  assert.equal((await manage(new Request('https://app.example/mcp/api/device-distribution?source_id=native-ios', { method: 'PUT', body: 'x'.repeat(settings.distribution.max_input_chars + 1) }), o)).status, 413);
  assert.equal((await manage(new Request('https://app.example/mcp/api/device-distribution?source_id=native-ios', { method: 'PATCH', body: '{}' }), o)).status, 405);
  assert.equal(o.writes.length, 0);
});

test('owner publish needs current identity, writes through the existing CAS and confirms the readback', async () => {
  const o = owner();
  const get = await manage(new Request('https://app.example/mcp/api/device-distribution?source_id=native-ios'), o);
  assert.equal((await get.json()).identity, null);
  assert.equal((await manage(put({ source_id: 'native-ios', observation: observation() }), o)).status, 409);
  const saved = await manage(put({ source_id: 'native-ios', observation: observation(), expected_identity: null }), o);
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.saved, true);
  assert.equal(result.identity, workspaceValueIdentity(o.value()));
  assert.equal(o.writes[0][0].address_label, distributionRecordLabel('native-ios'));
  assert.equal(o.writes[0][0].expected_identity, null);
  assert.equal(o.value().changed_by, 'release-owner');
  const unchanged = await manage(put({ source_id: 'native-ios', observation: observation(), expected_identity: result.identity }), o);
  assert.equal((await unchanged.json()).unchanged, true);
  assert.equal(o.writes.length, 1);
  assert.equal((await manage(put({ source_id: 'native-ios', observation: observation(), expected_identity: null }), o)).status, 409);
});

test('racing, unconfirmed and regressive updates refuse instead of claiming a saved observation', async () => {
  for (const options of [{ conflict: true }, { noSave: true }]) {
    const o = owner(null, options);
    assert.equal((await manage(put({ source_id: 'native-ios', expected_identity: null, observation: observation() }), o)).status, 409);
  }
  const initial = { current: distributionObservation(source, observation(), now), history: [] }, o = owner(initial);
  const old = observation({ checked_at: iso(now - 1000), expires_at: iso(now + 299000), routes: [route({ expires_at: iso(now + 299000) })] });
  assert.equal((await manage(put({ source_id: 'native-ios', expected_identity: workspaceValueIdentity(initial), observation: old }), o)).status, 409);
  assert.equal(o.writes.length, 0);
});

test('owner invalidation keeps bounded history and immediately removes install availability', async () => {
  const current = distributionObservation(source, observation(), now);
  const initial = { current, history: Array.from({ length: 20 }, () => current) }, o = owner(initial);
  const request = new Request('https://app.example/mcp/api/device-distribution', { method: 'DELETE', body: JSON.stringify({ source_id: 'native-ios', expected_identity: workspaceValueIdentity(initial) }) });
  assert.equal((await manage(request, o)).status, 200);
  assert.equal(o.value().current, null);
  assert.equal(o.value().history.length, settings.distribution.history_limit);
  const read = await readDeviceDistribution(o.operator, now);
  assert.equal(read['native-ios'], null);
  assert.equal(observedInstallWays(entry, read, now, observer)[0].available, null);
});

test('trusted reads use only configured source records and refresh stale facts through existing owner work', async () => {
  const current = distributionObservation(source, observation(), now), o = owner({ current });
  const pending = [];
  assert.equal((await readDeviceDistribution(o.operator, now))['native-ios'].source_id, 'native-ios');
  await readDeviceDistribution(o.operator, now + 300000, { refresh: true, waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  assert.deepEqual(o.reads, [distributionRecordLabel('native-ios'), distributionRecordLabel('native-ios')]);
  assert.equal(o.work.length, 1);
  assert.equal(o.work[0].tool_id, source.refresh_tool);
  assert.deepEqual(o.work[0].input, { source_id: 'native-ios', publish: true });
  assert.match(o.work[0].request_key, /^distribution:native-ios:/);
  assert.equal(o.work[0].wait_seconds, 0);
});

test('missing or failed owner reads remain unknown even when the optional refresh transport is unavailable', async () => {
  for (const operator of [undefined, { async workspaceRecord() { return null; } }, { async workspaceRecord() { throw new Error('offline'); }, runTool() { throw new Error('host unavailable'); } }]) {
    const pending = [];
    const read = await readDeviceDistribution(operator, now, { refresh: true, waitUntil: promise => pending.push(promise) });
    await Promise.allSettled(pending);
    assert.equal(read['native-ios'], null);
  }
});
