// The signup access path is conditional, account-bound and recoverable. Provider calls here are in-memory fixtures;
// these tests never connect to Apple, read a Keychain credential, send an email or invite a real tester.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSetupAccess, manageSetupAccess, signupAccessMandate, setupAccessRecordLabel, setupAccessSettings } from '../src/setup-access.mjs';
import { workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';
import { distributionSource } from '../../set-up-my-devices-and-cameras/src/device-distribution.mjs';
import { fulfillAppleSetupAccess, makeSetupAccessTools } from '../../app-release-access/read-data/setup-access.mjs';

const NOW = Date.parse('2026-10-08T05:00:00Z');
const ACCOUNT = 'account-one', OPERATOR = 'release-owner', SOURCE = 'native-ios', MAIL = 'fixture@example.test';
const policy = () => ({ sources: { [SOURCE]: { enabled: true, operation: 'invite', provider: 'apple-testflight', group_name: 'Founding members', version: 'human-version-1' } } });
const context = patch => ({ source_id: SOURCE, required: true, applicable: true, completed: false, verified_email: MAIL, observer: { device_family: 'IPHONE', os_version: '26.0' }, ...patch });
const identity = value => value == null ? null : workspaceValueIdentity(value);

function operatorStore({ configured = true } = {}) {
  const values = new Map(configured ? [[setupAccessSettings.policy_record, policy()]] : []), queued = [];
  return { values, queued, async workspaceRecord(label) { return structuredClone(values.get(label) ?? null); },
    async putWorkspaceRecords(rows) {
      for (const row of rows) if (identity(values.get(row.address_label)) !== row.expected_identity) return { ok: false, conflicts: [row.address_label] };
      for (const row of rows) values.set(row.address_label, structuredClone(row.payload));
      return { ok: true };
    },
    async runTool(origin, request) { assert.equal(origin, 'setup-access'); queued.push(request); return { task_id: `fixture-run-${queued.length}`, state: 'queued' }; },
  };
}

function ownerApi(operator, getContext = async () => context(), clock = () => NOW) {
  return async (body = {}, userId = ACCOUNT, method = 'POST') => {
    const url = new URL('https://app.example.test/mcp/api/setup-access');
    if (method === 'GET') for (const [key, value] of Object.entries(body)) url.searchParams.set(key, value);
    const response = await manageSetupAccess(new Request(url, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: SOURCE, ...body }) }) }), {
      userId, operatorId: OPERATOR, operator, readAccountContext: getContext, now: clock(),
    });
    return { status: response.status, body: await response.json() };
  };
}

async function prepared(operator, patch = {}) {
  return prepareSetupAccess({ operator, userId: ACCOUNT, sourceId: SOURCE, context: context(), consent: true, now: NOW, ...patch });
}

test('a versioned signup mandate requires a verified email and cannot transfer to a changed mailbox', async () => {
  const input = { version: setupAccessSettings.notice_version, userId: ACCOUNT, verifiedEmail: MAIL, verifiedAt: new Date(NOW - 1000).toISOString(), now: NOW };
  assert.equal(signupAccessMandate({ ...input, version: 'unshown-notice' }), null);
  assert.equal(signupAccessMandate({ ...input, verifiedAt: null }), null);
  const mandate = signupAccessMandate(input);
  assert.equal(mandate.account_id, ACCOUNT);
  assert.equal(mandate.recipient_identity, workspaceValueIdentity({ verified_email: MAIL }));
  const operator = operatorStore();
  const rejected = await prepared(operator, { consent: false, context: context({ verified_email: 'changed@example.test', mandate }) });
  assert.equal(rejected.blocker, 'mandate-missing');
  assert.equal(operator.queued.length, 0);
});

test('automatic preparation queues once only with selected requirement, policy, verified recipient and saved mandate', async () => {
  const operator = operatorStore();
  const mandate = signupAccessMandate({ version: setupAccessSettings.notice_version, userId: ACCOUNT, verifiedEmail: MAIL, verifiedAt: new Date(NOW - 1).toISOString(), now: NOW });
  const args = { consent: false, context: context({ mandate }) };
  const first = await prepared(operator, args), second = await prepared(operator, args);
  assert.equal(first.state, 'queued');
  assert.equal(second.request_id, first.request_id);
  assert.equal(operator.queued.length, 1);
  assert.deepEqual(operator.queued[0].input, { account_id: ACCOUNT, source_id: SOURCE, request_id: first.request_id });
  assert.equal(operator.queued[0].tool_id, 'tool:fulfill-setup-access');
  assert.ok(!JSON.stringify(first).includes(MAIL));
  assert.ok(!JSON.stringify(operator.queued[0]).includes(MAIL));
});

test('missing mandate, unverified recipient, optional requirement and missing policy do not queue invitations', async () => {
  for (const [patch, settings, blocker] of [
    [{ consent: false }, {}, 'mandate-missing'],
    [{ context: context({ verified_email: null }) }, {}, 'verified-email-missing'],
    [{ context: context({ required: false }) }, {}, 'not-required'],
    [{ context: context({ setup_paused: true }) }, {}, 'setup-paused'],
    [{}, { configured: false }, 'policy-missing'],
  ]) {
    const operator = operatorStore(settings);
    const answer = await prepared(operator, patch);
    assert.equal(answer.blocker, blocker);
    assert.equal(operator.queued.length, 0);
  }
});

test('a stopped setup cannot claim a queued invitation or resume it through access consent alone', async () => {
  const operator = operatorStore();
  let paused = false;
  const api = ownerApi(operator, async () => context({ setup_paused: paused }));
  const first = await prepared(operator);
  paused = true;
  const claimed = await api({ operation: 'claim', account_id: ACCOUNT, request_id: first.request_id }, OPERATOR);
  assert.equal(claimed.body.authorized, false);
  assert.equal(claimed.body.blocker, 'setup-paused');
  const attempted = await api({ operation: 'retry', consent: true, setup_paused: false });
  assert.equal(attempted.body.blocker, 'setup-paused', 'a customer body cannot restart the workflow owner');
  assert.equal(operator.queued.length, 1);
  paused = false;
  const restarted = await api({ operation: 'retry' });
  assert.equal(restarted.body.state, 'queued');
  assert.equal(restarted.body.request_id, first.request_id);
  assert.equal(operator.queued.length, 2, 'an observed restart allows the existing authorized request to recover');
});

test('observed setup withdrawal invalidates a held lease on preparation or at the next provider checkpoint', async () => {
  for (const through of ['prepare', 'checkpoint']) {
    const operator = operatorStore();
    let paused = false;
    const api = ownerApi(operator, async () => context({ setup_paused: paused }));
    const first = await prepared(operator), coordinates = { account_id: ACCOUNT, request_id: first.request_id };
    const claimed = await api({ ...coordinates, operation: 'claim' }, OPERATOR);
    const leased = { ...coordinates, lease_id: claimed.body.lease.id };
    assert.equal((await api({ ...leased, operation: 'checkpoint', mutation: 'enroll' }, OPERATOR)).body.allowed, true);
    paused = true;
    if (through === 'prepare') {
      const shown = await api({ operation: 'prepare' });
      assert.equal(shown.body.blocker, 'setup-paused');
      assert.equal(shown.body.refresh, true);
    }
    const nextMutation = await api({ ...leased, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR);
    assert.equal(nextMutation.status, through === 'prepare' ? 409 : 403);
    assert.notEqual(nextMutation.body.allowed, true);
    const current = (await api({ source_id: SOURCE }, ACCOUNT, 'GET')).body;
    assert.equal(current.state, 'blocked');
    assert.equal(current.blocker, 'setup-paused');
    assert.match(current.reason, /already started.*may still arrive/);
    assert.match(current.reason, /Restart setup/);
    assert.equal(current.action, null);
    assert.equal(operator.queued.length, 1);
    const kept = await operator.workspaceRecord(setupAccessRecordLabel(ACCOUNT, SOURCE));
    assert.equal(kept.lease, null);
    assert.equal(kept.mutations.enroll.state, 'attempted', 'pausing cannot erase a provider attempt');
    assert.equal(kept.mandate.revoked, undefined, 'setup withdrawal is distinct from canceling the access mandate');
    paused = false;
    await api({ operation: 'retry' });
    const fresh = await api({ ...coordinates, operation: 'claim' }, OPERATOR);
    assert.equal(fresh.body.authorized, true);
    assert.equal((await api({ ...coordinates, lease_id: fresh.body.lease.id, operation: 'checkpoint', mutation: 'enroll' }, OPERATOR)).body.allowed, false);
    assert.equal((await api({ ...coordinates, lease_id: fresh.body.lease.id, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR)).body.allowed, true);
  }
});

test('a currently usable public route skips invitation even without consent or policy', async () => {
  const operator = operatorStore({ configured: false });
  const answer = await prepared(operator, { consent: false, context: context({ usable_route: { available: true, state: 'ready', href: 'https://testflight.apple.com/join/Fixture', label: 'Join beta',
    checked_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 60000).toISOString() } }) });
  assert.equal(answer.state, 'available');
  assert.equal(operator.queued.length, 0);
  assert.equal(answer.action.href, 'https://testflight.apple.com/join/Fixture');
  assert.equal(answer.retry_at, new Date(NOW + 60000).toISOString());
});

async function availableRequest() {
  const operator = operatorStore();
  let current = context({ requirement_identity: 'same-required-iphone' }), time = NOW;
  const api = ownerApi(operator, async () => current, () => time);
  const first = await prepared(operator, { context: current });
  const claim = await api({ operation: 'claim', account_id: ACCOUNT, request_id: first.request_id }, OPERATOR);
  const availability = { checked_at: new Date(NOW - 1000).toISOString(), expires_at: new Date(NOW + 60000).toISOString() };
  const finish = result => api({ operation: 'finish', account_id: ACCOUNT, request_id: first.request_id, lease_id: claim.body.lease.id, result }, OPERATOR);
  const observed = { state: 'available', reason: 'Synthetic provider route is currently ready.', action: { href: 'https://testflight.apple.com/join/Fixture', label: 'Join beta' }, availability };
  return { operator, first, api, finish, observed, availability, context: () => current, change: patch => { current = { ...current, ...patch }; }, at: now => { time = now; } };
}

test('a provider public route keeps its actual expiry, survives unchanged screen reads and expires on every status projection', async () => {
  const fixture = await availableRequest();
  const finished = await fixture.finish(fixture.observed);
  assert.equal(finished.status, 200);
  assert.deepEqual(finished.body.availability, fixture.availability, 'receiving the result never resets its check time or expiry');
  assert.equal(finished.body.retry_at, fixture.availability.expires_at);
  const again = await prepared(fixture.operator, { context: fixture.context(), consent: false, now: NOW + 1000 });
  assert.equal(again.state, 'available');
  assert.equal(fixture.operator.queued.length, 1, 'a wake/reload must not enqueue another available-route check');
  fixture.at(NOW + 60000);
  const expired = await fixture.api({ source_id: SOURCE }, ACCOUNT, 'GET');
  assert.equal(expired.body.state, 'unknown');
  assert.equal(expired.body.action, null);
  assert.equal(expired.body.blocker, 'distribution-stale');
  assert.equal(expired.body.retry_at, null, 'an expired result cannot create a timer loop');
  fixture.at(NOW + 86400000);
  assert.equal((await fixture.api({ source_id: SOURCE }, ACCOUNT, 'GET')).body.action, null);
  const renewed = await prepared(fixture.operator, { context: fixture.context(), consent: false, now: NOW + 60001 });
  assert.equal(renewed.state, 'queued');
  assert.equal(renewed.action, null);
  assert.equal(fixture.operator.queued.length, 2, 'expiry permits one new owner check');
});

test('available access is revalidated when requirement, recipient, policy or observed device changes; cancel and explicit retry still work', async () => {
  for (const variation of ['requirement', 'recipient', 'policy', 'device', 'optional', 'disabled']) {
    const fixture = await availableRequest();
    assert.equal((await fixture.finish(fixture.observed)).status, 200);
    if (variation === 'requirement') fixture.change({ requirement_identity: 'a-different-required-step' });
    if (variation === 'recipient') fixture.change({ verified_email: 'different@example.test' });
    if (variation === 'device') fixture.change({ observer: { device_family: 'IPHONE', os_version: '15.0' } });
    if (variation === 'optional') fixture.change({ required: false });
    if (['policy', 'disabled'].includes(variation)) {
      const changed = policy();
      if (variation === 'policy') changed.sources[SOURCE].group_name = 'Another group';
      else changed.sources[SOURCE].enabled = false;
      fixture.operator.values.set(setupAccessSettings.policy_record, changed);
    }
    const answer = await prepared(fixture.operator, { context: fixture.context(), consent: false, now: NOW + 1000 });
    assert.notEqual(answer.state, 'available', variation);
    assert.equal(answer.action, null, variation);
  }
  const canceled = await availableRequest();
  await canceled.finish(canceled.observed);
  const reply = await canceled.api({ operation: 'cancel', request_id: canceled.first.request_id });
  assert.equal(reply.body.state, 'canceled'); assert.equal(reply.body.action, null);
  assert.equal((await prepared(canceled.operator, { context: canceled.context(), consent: false })).state, 'canceled');
  const retried = await availableRequest();
  await retried.finish(retried.observed);
  const next = await retried.api({ operation: 'retry' });
  assert.equal(next.body.state, 'queued'); assert.equal(next.body.action, null);
  assert.equal(retried.operator.queued.length, 2);
});

test('a provider result cannot advertise access without actual bounded fresh timestamps', async () => {
  for (const availability of [null, {}, { checked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 300001).toISOString() },
    { checked_at: new Date(NOW + 60000).toISOString(), expires_at: new Date(NOW + 90000).toISOString() },
    { checked_at: new Date(NOW - 60000).toISOString(), expires_at: new Date(NOW).toISOString() }]) {
    const fixture = await availableRequest();
    const reply = await fixture.finish({ ...fixture.observed, availability });
    assert.equal(reply.status, 400);
    assert.equal((await fixture.api({ source_id: SOURCE }, ACCOUNT, 'GET')).body.action, null);
  }
  const operator = operatorStore({ configured: false });
  const answer = await prepared(operator, { consent: false, context: context({ usable_route: { available: true, state: 'ready', href: 'https://testflight.apple.com/join/Fixture' } }) });
  assert.notEqual(answer.state, 'available', 'a timestamp-free trusted-context URL is still not a dated provider observation');
});

test('a late provider result cannot extend the target-device hint that made its public route eligible', async () => {
  const fixture = await availableRequest();
  fixture.at(NOW + 1000);
  const reply = await fixture.finish({ ...fixture.observed, availability: { checked_at: new Date(NOW + 1000).toISOString(), expires_at: new Date(NOW + 301000).toISOString() } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.availability.checked_at, new Date(NOW + 1000).toISOString());
  assert.equal(reply.body.availability.expires_at, new Date(NOW + 300000).toISOString());
  fixture.at(NOW + 300000);
  assert.equal((await fixture.api({ source_id: SOURCE }, ACCOUNT, 'GET')).body.action, null);
});

test('normal account reads only its own projection and cannot claim or fabricate provider completion', async () => {
  const operator = operatorStore(), api = ownerApi(operator), first = await prepared(operator);
  assert.equal((await api({ source_id: SOURCE, account_id: 'another' }, ACCOUNT, 'GET')).status, 403);
  assert.equal((await api({ operation: 'claim', request_id: first.request_id })).status, 403);
  assert.equal((await api({ operation: 'finish', request_id: first.request_id, result: { state: 'installed' } })).status, 403);
  const status = await api({ source_id: SOURCE }, ACCOUNT, 'GET');
  assert.equal(status.body.state, 'queued');
  assert.ok(!JSON.stringify(status.body).includes(MAIL));
});

test('operator claim rereads exact policy payload and email identity; human version does not mask group change', async () => {
  const operator = operatorStore(), first = await prepared(operator), api = ownerApi(operator);
  const changed = policy(); changed.sources[SOURCE].group_name = 'Different configured group';
  operator.values.set(setupAccessSettings.policy_record, changed);
  const claim = await api({ operation: 'claim', account_id: ACCOUNT, request_id: first.request_id }, OPERATOR);
  assert.equal(claim.body.authorized, false);
  assert.equal(claim.body.state, 'blocked');
  assert.ok(!JSON.stringify(claim.body).includes(MAIL));
  const another = operatorStore(), initial = await prepared(another), swapped = ownerApi(another, async () => context({ verified_email: 'replacement@example.test' }));
  assert.equal((await swapped({ operation: 'claim', account_id: ACCOUNT, request_id: initial.request_id }, OPERATOR)).body.authorized, false);
});

test('foreign operator context preserves only a recent server-observed target device hint', async () => {
  const operator = operatorStore();
  const first = await prepared(operator, { context: context({ observer: { device_family: 'IPHONE', os_version: '17.0' } }) });
  const api = ownerApi(operator, async () => context({ observer: null }));
  const claim = await api({ operation: 'claim', account_id: ACCOUNT, request_id: first.request_id, observer: { device_family: 'IPHONE', os_version: '99.0' } }, OPERATOR);
  assert.deepEqual(claim.body.observer, { device_family: 'IPHONE', os_version: '17.0' });
  const older = operatorStore(), initial = await prepared(older);
  const response = await manageSetupAccess(new Request('https://app.example.test/mcp/api/setup-access', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'claim', account_id: ACCOUNT, source_id: SOURCE, request_id: initial.request_id }) }), {
    userId: OPERATOR, operatorId: OPERATOR, operator: older, readAccountContext: async () => context({ observer: null }), now: NOW + 300001,
  });
  assert.equal((await response.json()).observer, null);
});

test('claim, checkpoints, cancellation and retry preserve the no-duplicate-send fence', async () => {
  const operator = operatorStore(), first = await prepared(operator), api = ownerApi(operator);
  const coords = { account_id: ACCOUNT, request_id: first.request_id };
  const claimed = await api({ ...coords, operation: 'claim' }, OPERATOR);
  assert.equal(claimed.body.recipient.email, MAIL);
  assert.equal((await api({ ...coords, operation: 'claim' }, OPERATOR)).status, 409);
  const lease = { ...coords, lease_id: claimed.body.lease.id };
  assert.equal((await api({ ...lease, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR)).body.allowed, true);
  assert.equal((await api({ ...lease, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR)).body.allowed, false);
  const canceled = await api({ ...coords, operation: 'cancel' });
  assert.match(canceled.body.reason, /already started.*may still arrive/);
  assert.equal((await api({ ...lease, operation: 'checkpoint', mutation: 'enroll' }, OPERATOR)).status, 409);
  assert.equal((await api({ operation: 'retry' })).body.state, 'canceled');
  const renewed = await api({ operation: 'retry', consent: true });
  const fresh = await api({ account_id: ACCOUNT, request_id: renewed.body.request_id, operation: 'claim' }, OPERATOR);
  assert.equal((await api({ account_id: ACCOUNT, request_id: renewed.body.request_id, lease_id: fresh.body.lease.id, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR)).body.allowed, false);
});

test('definite provider refusal can recover on explicit retry while ambiguous send cannot', async () => {
  for (const [receipt, allowed] of [[{ state: 'refused', http_status: 403 }, true], [{ state: 'not-started' }, true], [{ state: 'indeterminate', http_status: 503 }, false]]) {
    const operator = operatorStore(), first = await prepared(operator), api = ownerApi(operator), coords = { account_id: ACCOUNT, request_id: first.request_id };
    const claim = await api({ ...coords, operation: 'claim' }, OPERATOR), lease_id = claim.body.lease.id;
    await api({ ...coords, lease_id, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR);
    await api({ ...coords, lease_id, operation: 'finish', result: { state: 'indeterminate', mutation_outcomes: { 'send-invitation': receipt } } }, OPERATOR);
    await api({ operation: 'retry' });
    const retry = await api({ ...coords, operation: 'claim' }, OPERATOR);
    assert.equal((await api({ ...coords, lease_id: retry.body.lease.id, operation: 'checkpoint', mutation: 'send-invitation' }, OPERATOR)).body.allowed, allowed);
  }
});

test('actual native completion during a lease ends work; Apple INSTALLED alone only reports provider status', async () => {
  let facts = context();
  const operator = operatorStore(), first = await prepared(operator), api = ownerApi(operator, async () => facts), coords = { account_id: ACCOUNT, request_id: first.request_id };
  const claim = await api({ ...coords, operation: 'claim' }, OPERATOR);
  const installed = await api({ ...coords, lease_id: claim.body.lease.id, operation: 'finish', result: { state: 'installed', provider_state: 'INSTALLED' } }, OPERATOR);
  assert.equal(installed.body.provider_installation_reported, true);
  assert.equal(Object.hasOwn(installed.body, 'installation_verified'), false);
  assert.equal(facts.completed, false);
  const other = operatorStore(), next = await prepared(other), secondApi = ownerApi(other, async () => facts);
  const otherCoords = { account_id: ACCOUNT, request_id: next.request_id };
  const second = await secondApi({ ...otherCoords, operation: 'claim' }, OPERATOR);
  facts = context({ completed: true });
  assert.equal((await secondApi({ ...otherCoords, lease_id: second.body.lease.id, operation: 'finish', result: { state: 'blocked' } }, OPERATOR)).body.state, 'installed');
});

test('unchanged blocked reads stay recoverable and explicit retry gets a new Workshop key; deferred prepare can queue', async () => {
  const operator = operatorStore(), initial = await prepared(operator, { enqueue: false }), api = ownerApi(operator);
  assert.equal(initial.state, 'prepared'); assert.equal(operator.queued.length, 0);
  assert.equal((await prepared(operator, { consent: false })).state, 'queued');
  const coords = { account_id: ACCOUNT, request_id: initial.request_id };
  const claim = await api({ ...coords, operation: 'claim' }, OPERATOR);
  await api({ ...coords, lease_id: claim.body.lease.id, operation: 'finish', result: { state: 'blocked', blocker: 'provider-refused' } }, OPERATOR);
  assert.equal((await prepared(operator, { consent: false })).state, 'blocked');
  assert.equal(operator.queued.length, 1);
  await api({ operation: 'retry' });
  assert.equal(operator.queued.length, 2);
  assert.notEqual(operator.queued[0].request_key, operator.queued[1].request_key);
});

const listing = { app: { bundle_identifier: 'ai.fixture.ios' }, testflight: { groups: ['Founding members'] }, app_store_connect: { key_keychain_service: 'fixture', issuer_id: 'fixture' } };
const source = distributionSource(SOURCE);
function availability(patch = {}) {
  return { app_id: 'app-one', checked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 300000).toISOString(),
    groups: [{ id: 'group-one', name: 'Founding members', is_internal: false, candidate_scan_complete: true, app_capacity_state: 'ready',
      invitation_candidates: [{ build_id: 'build-one', external_state: 'IN_BETA_TESTING', auto_notify_enabled: true, eligibility_state: 'ready', expires_at: new Date(NOW + 300000).toISOString() }] }], routes: [], ...patch };
}
function dispatch(patch = {}) {
  return { account_id: ACCOUNT, source_id: SOURCE, request_id: 'request-one', authorized: true, recipient: { email: MAIL, verified: true },
    policy: { ...policy().sources[SOURCE] }, observer: { device_family: 'IPHONE', os_version: '26.0' },
    mandate: { by: ACCOUNT, account_id: ACCOUNT }, lease: { id: 'lease-one', expires_at: new Date(NOW + 300000).toISOString() }, ...patch };
}
function provider({ existing = false, inGroup = false, state = 'NOT_INVITED', afterEnroll = 'INVITED', failInvitation = null, failEnrollment = null } = {}) {
  const calls = [], reserve = new Set();
  let tester = existing, member = inGroup, providerState = state;
  const row = () => ({ type: 'betaTesters', id: 'tester-one', attributes: { email: MAIL, inviteType: 'EMAIL', state: providerState } });
  return { calls, reserve, setState(value) { providerState = value; },
    async checkpoint(name) { if (reserve.has(name)) return { allowed: false }; reserve.add(name); return { allowed: true }; },
    asc: {
      async get(path, { query } = {}) {
        calls.push({ method: 'GET', path, query });
        if (path === '/v1/apps') return { data: [{ type: 'apps', id: 'app-one', attributes: { bundleId: listing.app.bundle_identifier } }] };
        if (path === '/v1/betaTesters' && query['filter[email]']) return { data: tester ? [row()] : [] };
        if (path === '/v1/betaTesters' && query['filter[id]']) return { data: tester && member ? [row()] : [] };
        throw new Error('unexpected-fixture-read');
      },
      async post(path, body, accepted) {
        calls.push({ method: 'POST', path, body, accepted });
        if (path === '/v1/betaTesters') { if (failEnrollment) throw failEnrollment; tester = true; member = true; providerState = afterEnroll; return { data: row() }; }
        if (path === '/v1/betaGroups/group-one/relationships/betaTesters') { member = true; providerState = afterEnroll; return null; }
        if (path === '/v1/betaTesterInvitations') { if (failInvitation) throw failInvitation; providerState = 'INVITED'; return { data: { id: 'invitation-one', type: 'betaTesterInvitations' } }; }
        throw new Error('unexpected-fixture-mutation');
      },
    },
  };
}
const perform = (fixture, { report = availability(), request = dispatch() } = {}) => fulfillAppleSetupAccess({ asc: fixture.asc, dispatch: request, listing, source, checkpoint: fixture.checkpoint, readAvailability: async () => report, now: () => NOW });
const mutations = fixture => fixture.calls.filter(call => call.method === 'POST');

test('usable public TestFlight route and accepted existing tester require no invitation mutation', async () => {
  const fixture = provider();
  const publicReport = availability({ routes: [{ channel: 'public_link', state: 'ready', distribution_state: 'ready', eligibility_state: 'ready', expires_at: new Date(NOW + 300000).toISOString(), action: { href: 'https://testflight.apple.com/join/Fixture' } }] });
  publicReport.routes[0].expires_at = new Date(NOW + 60000).toISOString();
  const available = await perform(fixture, { report: publicReport });
  assert.equal(available.state, 'available');
  assert.deepEqual(available.availability, { checked_at: publicReport.checked_at, expires_at: publicReport.routes[0].expires_at });
  const request = await availableRequest();
  const saved = await request.finish(available);
  assert.equal(saved.body.retry_at, publicReport.routes[0].expires_at, 'the native provider deadline reaches the actual server projection');
  assert.equal(mutations(fixture).length, 0);
  const known = provider({ existing: true, inGroup: true, state: 'ACCEPTED' });
  assert.equal((await perform(known)).state, 'accepted');
  assert.equal(mutations(known).length, 0);
});

test('new tester enrollment uses the server mailbox and configured external group; replay only reads', async () => {
  const fixture = provider();
  const first = await perform(fixture), second = await perform(fixture);
  assert.equal(first.state, 'invited'); assert.equal(second.state, 'invited');
  assert.equal(mutations(fixture).length, 1);
  assert.deepEqual(mutations(fixture)[0].body.data.attributes, { email: MAIL });
  assert.deepEqual(mutations(fixture)[0].body.data.relationships.betaGroups.data, [{ type: 'betaGroups', id: 'group-one' }]);
  assert.ok(!JSON.stringify(first).includes(MAIL));
});

test('existing tester without membership is added once and unknown future iPhone OS does not block consented invitation', async () => {
  const fixture = provider({ existing: true });
  const report = availability(); report.groups[0].invitation_candidates[0].external_state = 'BETA_APPROVED'; report.groups[0].invitation_candidates[0].eligibility_state = 'unknown';
  const answer = await perform(fixture, { report, request: dispatch({ observer: null }) });
  assert.equal(answer.state, 'invited');
  assert.equal(mutations(fixture)[0].path, '/v1/betaGroups/group-one/relationships/betaTesters');
  assert.deepEqual(mutations(fixture)[0].accepted, [204]);
});

test('known incompatible target phone, missing approved candidate and unknown capacity refuse enrollment', async () => {
  for (const alter of [
    report => { report.groups[0].invitation_candidates[0].eligibility_state = 'blocked'; },
    report => { report.groups[0].invitation_candidates[0].external_state = 'WAITING_FOR_BETA_REVIEW'; },
    report => { report.groups[0].app_capacity_state = 'unknown'; },
  ]) {
    const fixture = provider(), report = availability(); alter(report);
    assert.equal((await perform(fixture, { report })).state, 'blocked');
    assert.equal(mutations(fixture).length, 0);
  }
});

test('public route expiry and build expiry during a checkpoint cannot become available access or an invitation', async () => {
  const fixture = provider();
  const stale = availability({ routes: [{ channel: 'public_link', state: 'ready', distribution_state: 'ready', eligibility_state: 'ready', expires_at: new Date(NOW - 1).toISOString(), action: { href: 'https://testflight.apple.com/join/Fixture' } }] });
  stale.groups[0].invitation_candidates = [];
  assert.equal((await perform(fixture, { report: stale })).state, 'blocked');
  assert.equal(mutations(fixture).length, 0);
  let clock = NOW;
  const expiring = availability(); expiring.groups[0].invitation_candidates[0].expires_at = new Date(NOW + 500).toISOString();
  const answer = await fulfillAppleSetupAccess({ asc: fixture.asc, dispatch: dispatch(), listing, source, readAvailability: async () => expiring, now: () => clock,
    checkpoint: async () => { clock = NOW + 1000; return { allowed: true }; } });
  assert.equal(answer.blocker, 'distribution-stale');
  assert.equal(answer.mutation_outcomes.enroll.state, 'not-started');
  assert.equal(mutations(fixture).length, 0);
});

test('manual notification sends one first invitation only from NOT_INVITED and records actual readback', async () => {
  const fixture = provider({ existing: true, inGroup: true });
  const report = availability(); report.groups[0].invitation_candidates[0].auto_notify_enabled = false;
  const answer = await perform(fixture, { report });
  assert.equal(answer.state, 'invited');
  assert.deepEqual([...fixture.reserve], ['send-invitation']);
  assert.equal(mutations(fixture).length, 1);
  assert.equal(mutations(fixture)[0].path, '/v1/betaTesterInvitations');
  assert.equal(answer.mutation_outcomes['send-invitation'].state, 'observed');
});

test('automatic notification pending does not trigger an extra manual email', async () => {
  const fixture = provider({ existing: true, inGroup: true });
  assert.equal((await perform(fixture)).state, 'awaiting-invitation');
  assert.equal(mutations(fixture).length, 0);
});

test('uncertain invitation result is safe and replay does not send a second email', async () => {
  const error = new Error(`provider private body ${MAIL} secret-token`);
  const fixture = provider({ existing: true, inGroup: true, failInvitation: error });
  const report = availability(); report.groups[0].invitation_candidates[0].auto_notify_enabled = false;
  const first = await perform(fixture, { report }), retry = await perform(fixture, { report });
  assert.equal(first.state, 'indeterminate'); assert.equal(retry.state, 'indeterminate');
  assert.equal(mutations(fixture).length, 1);
  assert.ok(!JSON.stringify(first).includes('secret-token'));
  assert.ok(!JSON.stringify(first).includes(MAIL));
  fixture.setState('INVITED');
  assert.equal((await perform(fixture, { report })).state, 'invited');
  assert.equal(mutations(fixture).length, 1);
});

test('revoked testers and an incomplete exact-email lookup cannot acquire another invitation', async () => {
  const revoked = provider({ existing: true, inGroup: true, state: 'REVOKED' });
  assert.equal((await perform(revoked)).state, 'revoked');
  assert.equal(mutations(revoked).length, 0);
  const ambiguous = provider(); const get = ambiguous.asc.get;
  ambiguous.asc.get = async (path, opts) => opts?.query?.['filter[email]'] ? { data: [], links: { next: 'https://other.example.test/untrusted' } } : get(path, opts);
  assert.equal((await perform(ambiguous)).state, 'indeterminate');
  assert.equal(mutations(ambiguous).length, 0);
});

test('native tool rejects caller-provided recipient and never connects after a refused claim', async () => {
  let connections = 0, reads = 0;
  const tool = makeSetupAccessTools({ connect() { connections++; throw new Error('must not connect'); }, readListing: async () => listing,
    fetchImpl: async () => { reads++; return Response.json({ authorized: false, state: 'blocked' }); }, now: () => NOW });
  const input = { account_id: ACCOUNT, source_id: SOURCE, request_id: 'request-one' }, options = { origin: 'https://app.example.test', key: 'fixture-key' };
  await assert.rejects(tool.fulfill({ ...input, email: 'arbitrary@example.test' }, options), /Recipients.*server/);
  assert.equal(reads, 0);
  assert.equal((await tool.fulfill(input, options)).state, 'blocked');
  assert.equal(connections, 0);
});

test('native host executes authenticated claim/checkpoint/finish and returns no verified mailbox', async () => {
  const fixture = provider(), operations = [];
  const tool = makeSetupAccessTools({ connect: () => fixture.asc, readListing: async () => listing, readAvailability: async () => availability(), now: () => NOW,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/mcp/api/setup-access');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body); operations.push(body.operation);
      if (body.operation === 'claim') return Response.json(dispatch());
      if (body.operation === 'checkpoint') return Response.json({ allowed: true });
      assert.equal(body.result.state, 'invited');
      return Response.json({ state: body.result.state, request_id: body.request_id });
    } });
  const answer = await tool.fulfill({ account_id: ACCOUNT, source_id: SOURCE, request_id: 'request-one' }, { origin: 'https://app.example.test', key: 'fixture-key' });
  assert.deepEqual(operations, ['claim', 'checkpoint', 'finish']);
  assert.equal(answer.state, 'invited');
  assert.ok(!JSON.stringify(answer).includes(MAIL));
});
