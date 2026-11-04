// These are read-only provider contract tests. No Apple credentials or mutation endpoints are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTestFlightAvailability } from '../read-data/testflight-readiness.mjs';

const now = '2026-10-08T05:00:00.000Z';
const observer = { device_family: 'IPHONE', os_version: '18.0' };
const makeBuild = (id = 'b1', attributes = {}) => ({ id, type: 'builds', attributes: { version: id, uploadedDate: now, processingState: 'VALID', expired: false, expirationDate: '2026-12-01T00:00:00Z', minOsVersion: '18.0', ...attributes } });
const makeGroup = (attributes = {}) => ({ id: 'g1', type: 'betaGroups', attributes: { name: 'Members', isInternalGroup: false, publicLink: 'https://testflight.apple.com/join/AbC123', publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 100, ...attributes }, relationships: { betaRecruitmentCriteria: { data: null } } });
const copy = value => structuredClone(value);

function fixture(options = {}) {
  const selected = options.selected === null ? null : options.selected ?? makeBuild();
  const groups = options.groups ?? [makeGroup(options.groupAttributes)];
  const candidates = options.candidates ?? (selected ? [selected] : []);
  const calls = [];
  const asc = {
    async get(path, { query = {} } = {}) {
      calls.push({ method: 'GET', path, query });
      const intercepted = await options.intercept?.(path, query);
      if (intercepted !== undefined) return copy(intercepted);
      if (path === '/v1/betaGroups') return copy({ data: groups });
      if (path === '/v1/builds') return copy({ data: selected ? [selected] : [] });
      if (path === `/v1/builds/${selected?.id}`) return copy({ data: selected });
      if (path.endsWith('/app')) return { data: { id: 'a1' } };
      if (path.endsWith('/builds')) return copy({ data: candidates });
      if (path.endsWith('/buildBetaDetail')) {
        const id = path.split('/')[3];
        return { data: { id: `detail-${id}`, attributes: { externalBuildState: options.states?.[id] ?? 'IN_BETA_TESTING', autoNotifyEnabled: true } } };
      }
      if (path.endsWith('/relationships/betaRecruitmentCriteria')) return { data: options.filters ? { id: 'c1' } : null };
      if (path.endsWith('/betaRecruitmentCriteria')) return copy({ data: { id: 'c1', attributes: { deviceFamilyOsVersionFilters: options.filters } } });
      if (path.endsWith('/betaRecruitmentCriterionCompatibleBuildCheck')) return { data: { attributes: { hasCompatibleBuild: options.compatible ?? true } } };
      if (path === '/v1/betaTesters') {
        if (query['filter[id]']) return copy({ data: options.tester === null ? [] : [{ id: 't1', attributes: { inviteType: 'EMAIL', state: 'ACCEPTED', ...options.tester } }] });
        return { data: [], meta: { paging: { total: query['filter[inviteType]'] === 'PUBLIC_LINK' ? options.publicCount ?? 5 : options.appCount ?? 6 } } };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    async post() { assert.fail('Readiness must not POST.'); },
    async patch() { assert.fail('Readiness must not PATCH.'); },
    async delete() { assert.fail('Readiness must not DELETE.'); },
  };
  return { calls, asc, read: overrides => readTestFlightAvailability({ asc, appId: 'a1', testflight: { groups: ['Members'] }, observer, now, ...overrides }) };
}
const publicRoutes = report => report.routes.filter(route => route.channel === 'public_link');
const activeRoute = (report, id = 'b1', channel = 'public_link') => report.routes.find(route => route.build_id === id && route.channel === channel);

test('active external build, confirmed group, enabled link, room and eligible OS produce a dated read-only route', async () => {
  const f = fixture(), report = await f.read();
  const route = activeRoute(report);
  assert.equal(report.state, 'ready');
  assert.equal(report.selected_build_state, 'ready');
  assert.equal(report.route_scope, 'configured_group');
  assert.equal(report.installation_verified, false);
  assert.equal(route.id, 'testflight-public:g1:b1');
  assert.equal(route.state, 'ready');
  assert.equal(route.action.href, 'https://testflight.apple.com/join/AbC123');
  assert.equal(route.checked_at, now);
  assert.equal(route.expires_at, '2026-10-08T05:05:00.000Z');
  assert.equal(route.evidence.external_state, 'IN_BETA_TESTING');
  assert.deepEqual(route.eligibility_requirements, { scope: 'minimum_os_and_public_recruitment', known: true, alternatives: [{ device_family: null, minimum_os: '18.0', maximum_os: null }] });
  assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.ok(!f.calls.some(call => /^\/v1\/builds\/[^/]+\/betaGroups/.test(call.path)), 'membership uses the documented group-to-build relationship');
  assert.ok(!report.routes.some(route => route.channel === 'email'));
});

test('preactivation candidates support invitation preparation without claiming access or delivering anything', async () => {
  const f = fixture({ states: { b1: 'BETA_APPROVED' } });
  const report = await f.read();
  assert.equal(report.state, 'unknown');
  assert.equal(report.groups[0].candidate_scan_complete, true);
  assert.equal(report.groups[0].app_capacity_state, 'ready');
  assert.deepEqual(report.groups[0].invitation_candidates, [{ build_id: 'b1', external_state: 'BETA_APPROVED', auto_notify_enabled: true, min_os_version: '18.0', expires_at: '2026-10-08T05:05:00.000Z', eligibility_state: 'ready', eligibility_requirements: { scope: 'minimum_os_and_public_recruitment', known: true, alternatives: [{ device_family: null, minimum_os: '18.0', maximum_os: null }] } }]);
  assert.ok(report.routes.every(row => row.action === null));
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const pending = await fixture({ states: { b1: 'WAITING_FOR_BETA_REVIEW' } }).read();
  assert.deepEqual(pending.groups[0].invitation_candidates, []);
  const expired = await fixture({ selected: makeBuild('b1', { expired: true }) }).read();
  assert.deepEqual(expired.groups[0].invitation_candidates, []);
});

test('a pending newest upload cannot hide the previous active build in the group', async () => {
  const older = makeBuild('old', { uploadedDate: '2026-10-07T00:00:00Z' }), latest = makeBuild('new');
  const f = fixture({ selected: latest, candidates: [latest, older], states: { new: 'WAITING_FOR_BETA_REVIEW' } });
  const report = await f.read();
  assert.equal(report.build.id, 'new');
  assert.equal(report.selected_build_state, 'blocked');
  assert.equal(report.state, 'ready');
  assert.equal(activeRoute(report, 'old').state, 'ready');
  assert.ok(!activeRoute(report, 'new'));
  assert.deepEqual(report.groups[0].active_build_ids, ['old']);
});

test('build processing, beta submission, approval without active testing and expiry never mean externally ready', async t => {
  for (const external of ['PROCESSING', 'READY_FOR_BETA_SUBMISSION', 'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_APPROVED', 'READY_FOR_BETA_TESTING', 'BETA_REJECTED', 'NOT_APPLICABLE']) {
    await t.test(external, async () => {
      const report = await fixture({ states: { b1: external } }).read();
      const expected = ['BETA_APPROVED', 'READY_FOR_BETA_TESTING'].includes(external) ? 'unknown' : 'blocked';
      assert.equal(report.selected_build_state, expected);
      assert.equal(report.state, expected);
      assert.ok(report.routes.every(route => route.action === null));
    });
  }
  for (const attributes of [{ processingState: 'PROCESSING' }, { processingState: 'FAILED' }, { expired: true }, { expirationDate: now }]) {
    const report = await fixture({ selected: makeBuild('b1', attributes) }).read();
    assert.equal(report.state, 'blocked');
  }
});

test('unknown state or missing expiry stays unknown; a subsequent authoritative read recovers', async () => {
  for (const options of [{ states: { b1: 'NEW_UNKNOWN_STATE' } }, { selected: makeBuild('b1', { expirationDate: null }) }, { selected: makeBuild('b1', { expired: null }) }]) {
    const report = await fixture(options).read();
    assert.equal(report.state, 'unknown');
    assert.equal(report.selected_build_state, 'unknown');
  }
  let unavailable = true;
  const f = fixture({ intercept(path) { if (path.endsWith('/buildBetaDetail') && unavailable) { const e = new Error('Private provider response someone@example.invalid'); e.status = 503; throw e; } } });
  const failed = await f.read();
  assert.equal(failed.state, 'unknown');
  assert.deepEqual(failed.errors, [{ operation: '/v1/builds/b1/buildBetaDetail', http_status: 503 }]);
  assert.ok(!JSON.stringify(failed).includes('someone@'));
  unavailable = false;
  assert.equal((await f.read()).state, 'ready');
});

test('each active build is its own eligibility alternative and owns its expiry', async () => {
  const latest = makeBuild('new', { minOsVersion: '26.0', expirationDate: '2026-10-08T05:01:00Z' });
  const older = makeBuild('old', { uploadedDate: '2026-10-07T00:00:00Z', minOsVersion: '18.0' });
  const report = await fixture({ selected: latest, candidates: [latest, older] }).read();
  assert.equal(activeRoute(report, 'new').eligibility_state, 'blocked');
  assert.equal(activeRoute(report, 'new').distribution_state, 'ready');
  assert.equal(activeRoute(report, 'new').expires_at, '2026-10-08T05:01:00.000Z');
  assert.equal(activeRoute(report, 'old').state, 'ready');
  assert.equal(activeRoute(report, 'old').expires_at, '2026-10-08T05:05:00.000Z');
  assert.equal(report.state, 'ready');
  const expired = makeBuild('new', { expirationDate: '2026-10-08T04:59:00Z' });
  assert.equal(activeRoute(await fixture({ selected: expired, candidates: [expired, older] }).read(), 'old').expires_at, '2026-10-08T05:05:00.000Z');
});

test('without observer a route exposes evaluable evidence, not verified person access or an action', async () => {
  const report = await fixture().read({ observer: undefined });
  const route = activeRoute(report);
  assert.equal(report.state, 'unknown');
  assert.equal(report.distribution_state, 'ready');
  assert.equal(route.eligibility_state, 'unknown');
  assert.equal(route.min_os_version, '18.0');
  assert.equal(route.eligibility_requirements.known, true);
  assert.equal(route.action, null);
  assert.equal(route.evidence.public_link, 'https://testflight.apple.com/join/AbC123');
});

test('configured group membership is required; missing and unreadable groups are distinct', async () => {
  assert.equal((await fixture({ groups: [] }).read()).state, 'blocked');
  assert.equal((await fixture({ groups: [makeGroup(), makeGroup()] }).read()).state, 'unknown');
  assert.equal((await fixture({ groupAttributes: { isInternalGroup: true } }).read()).state, 'blocked');
  assert.equal((await fixture({ assigned: [], candidates: [] }).read()).state, 'blocked');
  const failed = fixture({ intercept(path) { if (path === '/v1/betaGroups') { const e = new Error('denied'); e.status = 403; throw e; } } });
  assert.equal((await failed.read()).state, 'unknown');
});

test('disabled, full and unsafe public links never imply named email tester access is blocked', async () => {
  for (const options of [{ groupAttributes: { publicLinkEnabled: false } }, { publicCount: 100 }, { groupAttributes: { publicLink: 'https://evil.invalid/join/AbC123' } }]) {
    const report = await fixture(options).read({ testerId: 't1' });
    assert.notEqual(activeRoute(report).state, 'ready');
    assert.equal(activeRoute(report, 'b1', 'email').state, 'ready');
    assert.equal(report.state, 'ready');
  }
  for (const state of ['NOT_INVITED', 'REVOKED', 'INVITED', 'ACCEPTED', 'INSTALLED']) {
    const report = await fixture({ groupAttributes: { publicLinkEnabled: false }, tester: { state } }).read({ testerId: 't1' });
    const email = activeRoute(report, 'b1', 'email');
    assert.equal(email.eligibility_state, ['ACCEPTED', 'INSTALLED'].includes(state) ? 'ready' : state === 'INVITED' ? 'unknown' : 'blocked');
    assert.equal(email.evidence.invitation_send_performed, false);
    assert.equal(report.installation_verified, false);
    assert.ok(!JSON.stringify(report).includes('t1'));
  }
  assert.equal(activeRoute(await fixture({ tester: null }).read({ testerId: 't1' }), 'b1', 'email').state, 'blocked');
  assert.equal(activeRoute(await fixture({ tester: { inviteType: 'PUBLIC_LINK' } }).read({ testerId: 't1' }), 'b1', 'email').state, 'blocked');
});

test('capacity must be proved; mixed app tester count at 10,000 cannot prove external fullness', async () => {
  assert.equal(activeRoute(await fixture({ appCount: 10000 }).read()).distribution_state, 'unknown');
  assert.equal(activeRoute(await fixture({ groupAttributes: { publicLinkLimitEnabled: null } }).read()).distribution_state, 'unknown');
  const f = fixture({ intercept(path, query) { if (path === '/v1/betaTesters' && query['filter[inviteType]'] === 'PUBLIC_LINK') return { data: [{ id: 'count-only' }], links: { next: '/v1/betaTesters?cursor=2' } }; } });
  assert.equal(activeRoute(await f.read()).distribution_state, 'unknown');
  assert.equal(activeRoute(await fixture({ groupAttributes: { publicLinkLimitEnabled: false } }).read()).state, 'ready');
});

test('public recruitment criteria are verified and use inclusive numeric OS comparisons', async () => {
  const group = makeGroup();
  delete group.relationships;
  const filters = [{ deviceFamily: 'IPHONE', minimumOsInclusive: '18.0', maximumOsInclusive: '18.10' }];
  const f = fixture({ groups: [group], filters });
  const report = await f.read({ observer: { device_family: 'IPHONE', os_version: '18.10' } });
  assert.equal(activeRoute(report).state, 'ready');
  assert.deepEqual(activeRoute(report).eligibility_requirements.alternatives, [{ device_family: 'IPHONE', minimum_os: '18.0', maximum_os: '18.10' }]);
  assert.equal(activeRoute(await f.read({ observer: { device_family: 'IPHONE', os_version: '18.11' } })).state, 'blocked');
  assert.equal(activeRoute(await f.read({ observer: { device_family: 'IPAD', os_version: '18.0' } })).state, 'blocked');
  assert.equal(activeRoute(await fixture({ groups: [group], filters, compatible: false }).read()).distribution_state, 'blocked');
  const bounded = await fixture({ groups: [group], filters: [{ deviceFamily: 'IPHONE', minimumOsInclusive: '18.2' }] }).read({ observer: { device_family: 'IPHONE', os_version: '18.10' } });
  assert.equal(activeRoute(bounded).state, 'ready');
  assert.equal(activeRoute(bounded).eligibility_requirements.alternatives[0].minimum_os, '18.2');
});

test('missing/malformed recruitment data remains unknown, including a 404 relation', async () => {
  const group = makeGroup();
  delete group.relationships;
  const failed = fixture({ groups: [group], intercept(path) { if (path.endsWith('/relationships/betaRecruitmentCriteria')) { const e = new Error('not found'); e.status = 404; throw e; } } });
  assert.equal(activeRoute(await failed.read()).state, 'unknown');
  const malformed = await fixture({ groups: [group], filters: [{ deviceFamily: 'IPHONE', minimumOsInclusive: 'beta' }] }).read();
  assert.equal(activeRoute(malformed).state, 'unknown');
  assert.equal(activeRoute(malformed).eligibility_requirements.known, false);
});

test('pagination follows Apple only, keeps earlier positive evidence, and never declares absence from partial reads', async () => {
  const pending = makeBuild('new'), older = makeBuild('old', { uploadedDate: '2026-10-07T00:00:00Z' });
  const f = fixture({ selected: pending, assigned: [], states: { new: 'WAITING_FOR_BETA_REVIEW' }, intercept(path) {
    if (path === '/v1/betaGroups/g1/builds') return { data: [pending], links: { next: 'https://api.appstoreconnect.apple.com/v1/betaGroups/g1/builds?cursor=2' } };
    if (path === '/v1/betaGroups/g1/builds?cursor=2') return { data: [older] };
  } });
  assert.equal(activeRoute(await f.read(), 'old').state, 'ready');
  const unsafe = fixture({ selected: pending, assigned: [], states: { new: 'WAITING_FOR_BETA_REVIEW' }, intercept(path) { if (path === '/v1/betaGroups/g1/builds') return { data: [pending], links: { next: 'https://evil.invalid/v1/betaGroups/g1/builds?cursor=2' } }; } });
  assert.equal((await unsafe.read()).state, 'unknown');
  assert.ok(!unsafe.calls.some(call => call.path.includes('evil.invalid')));
  const positive = fixture({ assigned: [], intercept(path) { if (path === '/v1/betaGroups/g1/builds') return { data: [makeBuild()], links: { next: 'https://evil.invalid/v1/betaGroups/g1/builds?cursor=2' } }; } });
  const report = await positive.read();
  assert.equal(report.state, 'ready');
  assert.equal(report.groups[0].candidate_scan_complete, false);
  assert.ok(publicRoutes(report).some(route => route.state === 'unknown'));
});

test('bounded detail reads leave unseen possible builds unknown rather than blocked', async () => {
  const candidates = Array.from({ length: 25 }, (_, i) => makeBuild(`b${i + 2}`));
  const states = Object.fromEntries(candidates.map(build => [build.id, 'WAITING_FOR_BETA_REVIEW']));
  const f = fixture({ selected: null, assigned: [], candidates, states });
  const report = await f.read();
  assert.equal(report.state, 'unknown');
  assert.equal(report.groups[0].candidate_scan_complete, false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/buildBetaDetail')).length, 20);
});

test('ambiguous build numbers and wrong selected app cannot suppress separately verified group routes', async () => {
  const ambiguous = fixture({ intercept(path) { if (path === '/v1/builds') return { data: [makeBuild('a'), makeBuild('b')] }; } });
  const a = await ambiguous.read({ number: '42' });
  assert.equal(a.selected_build_state, 'unknown');
  assert.equal(a.state, 'ready');
  const wrong = fixture({ candidates: [makeBuild('other')], intercept(path) { if (path.endsWith('/app')) return { data: { id: 'another-app' } }; } });
  const b = await wrong.read({ buildId: 'b1' });
  assert.equal(b.selected_build_state, 'blocked');
  assert.equal(b.state, 'ready');
  assert.equal(activeRoute(b, 'other').state, 'ready');
  assert.equal(b.groups[0].selected_build_association, 'blocked');
});

test('requested freshness is bounded and no group configuration remains unknown', async () => {
  assert.equal((await fixture().read({ validForMs: 1000 })).expires_at, '2026-10-08T05:00:01.000Z');
  assert.equal((await fixture().read({ validForMs: 900000 })).expires_at, '2026-10-08T05:05:00.000Z');
  const report = await fixture().read({ testflight: undefined });
  assert.equal(report.state, 'unknown');
  assert.deepEqual(report.routes, []);
  await assert.rejects(fixture().read({ testflight: { groups: 'Members' } }), /array/);
});
