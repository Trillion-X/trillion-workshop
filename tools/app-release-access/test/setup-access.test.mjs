// Moved from old trillion test/setup-access.test.mjs: the provider adapter (fulfillAppleSetupAccess) and the tool's
// claim/checkpoint/finish fence (makeSetupAccessTools). The account-side preparation and projection tests stay with
// the engine's owner of src/setup-access; the operator is the injected claim/checkpoint/finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { distributionSource } from '../read-data/distribution.mjs';
import { fulfillAppleSetupAccess, makeSetupAccessTools, fulfill } from '../read-data/setup-access.mjs';

const NOW = Date.parse('2026-10-08T05:00:00Z');
const ACCOUNT = 'account-one', SOURCE = 'native-ios', MAIL = 'fixture@example.test';
const policy = () => ({ sources: { [SOURCE]: { enabled: true, operation: 'invite', provider: 'apple-testflight', group_name: 'Founding members', version: 'human-version-1' } } });
const listing = { app: { bundle_identifier: 'ai.fixture.ios' }, testflight: { groups: ['Founding members'] } };
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

const toolInput = { account_id: ACCOUNT, source_id: SOURCE, request_id: 'request-one', bundle_identifier: listing.app.bundle_identifier, testflight_groups: listing.testflight.groups };

test('native tool rejects caller-provided recipient and never connects after a refused claim', async () => {
  let connections = 0, reads = 0;
  const tool = makeSetupAccessTools({ connect() { connections++; throw new Error('must not connect'); }, readKey: () => ({}),
    operator: async () => { reads++; return { authorized: false, state: 'blocked' }; }, now: () => NOW });
  await assert.rejects(tool.fulfill({ ...toolInput, email: 'arbitrary@example.test' }), /Recipients.*server/);
  assert.equal(reads, 0);
  assert.equal((await tool.fulfill(toolInput)).state, 'blocked');
  assert.equal(connections, 0);
});

test('native host executes authenticated claim/checkpoint/finish and returns no verified mailbox', async () => {
  const fixture = provider(), operations = [];
  const tool = makeSetupAccessTools({ connect: () => fixture.asc, readKey: () => ({}), readAvailability: async () => availability(), now: () => NOW,
    operator: async (operation, body) => {
      assert.equal(body.operation, operation);
      operations.push(body.operation);
      if (body.operation === 'claim') return dispatch();
      if (body.operation === 'checkpoint') return { allowed: true };
      assert.equal(body.result.state, 'invited');
      return { state: body.result.state, request_id: body.request_id };
    } });
  const answer = await tool.fulfill(toolInput);
  assert.deepEqual(operations, ['claim', 'checkpoint', 'finish']);
  assert.equal(answer.state, 'invited');
  assert.ok(!JSON.stringify(answer).includes(MAIL));
});

test('with no setup-access operation at the records door, the tool refuses before any provider call', async () => {
  await assert.rejects(fulfill(toolInput), /not operations a tool run can reach/);
});
