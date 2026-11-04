// tools/app-release-access/read-data/testflight-readiness.mjs (moved from old trillion scripts/testflight-readiness.mjs)
//
// Read Apple's current distribution facts without changing an app, group, build or tester.
// A processed upload or beta review submission is never evidence that external testing is active.
// Selected/latest upload readiness is separate from group availability: an older active build remains a valid route.
// Route IDs include their build, so different OS requirements cannot overwrite one another.
// Public recruitment, a named email tester's access, and device eligibility remain separate observations.
// This is not an installation receipt. Consumers still verify native sign-in and the capability they require.
//
// Protocol sources (Apple, checked 2026-10-08):
// https://developer.apple.com/documentation/appstoreconnectapi/externalbetastate
// https://developer.apple.com/documentation/appstoreconnectapi/betagroup/attributes-data.dictionary
// https://developer.apple.com/documentation/appstoreconnectapi/betarecruitmentcriterion/attributes-data.dictionary
// https://developer.apple.com/documentation/appstoreconnectapi/devicefamilyosversionfilter
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-betatesters
// https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/

const API = 'https://api.appstoreconnect.apple.com';
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_PAGES = 10;
const MAX_BUILD_DETAILS = 20;
const EXTERNAL_TESTER_LIMIT = 10000;
const externalStates = new Set(['PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'EXPIRED', 'READY_FOR_BETA_SUBMISSION', 'IN_EXPORT_COMPLIANCE_REVIEW', 'WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED', 'BETA_APPROVED', 'NOT_APPLICABLE']);
// Apple's "Ready to Test" can mean no testers yet or notification pending. Neither is proof of an active route,
// and approval alone cannot prove a route is unavailable. These states need a separate activation/access check.
const activationUnverified = new Set(['READY_FOR_BETA_TESTING', 'BETA_APPROVED']);
const knownFamilies = new Set(['IPHONE', 'IPAD', 'APPLE_TV', 'APPLE_WATCH', 'MAC', 'VISION']);
const check = (name, state, reason, details = {}) => ({ name, state, reason, ...details });
const stateOf = checks => checks.some(row => row.state === 'blocked') ? 'blocked' : checks.some(row => row.state === 'unknown') ? 'unknown' : 'ready';
const reasonOf = checks => checks.find(row => row.state === 'blocked')?.reason ?? checks.find(row => row.state === 'unknown')?.reason ?? 'Apple confirms the checked prerequisites.';

function nextPage(link, expectedPath) {
  const url = new URL(link, API);
  // The shared Apple client attaches its bearer token to every request. Pagination cannot change its destination.
  if (url.origin !== API || url.pathname !== expectedPath || url.username || url.password || url.hash) throw new Error('unsafe-pagination');
  return `${url.pathname}${url.search}`;
}

function reader(asc, errors) {
  async function get(path, query = {}) {
    let timer;
    try {
      return await Promise.race([
        asc.get(path, { query }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read-timeout')), 15000); }),
      ]);
    } catch (error) {
      // Provider response bodies may include a tester's address. Keep the failed operation and status, not its body.
      errors.push({ operation: path.split('?')[0], http_status: Number.isInteger(error?.status) ? error.status : null });
      return null;
    } finally { clearTimeout(timer); }
  }
  async function list(path, query = {}) {
    const rows = [];
    let current = path;
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      if (seen.has(current)) return { rows, complete: false };
      seen.add(current);
      const reply = await get(current, page ? {} : { limit: 200, ...query });
      if (!Array.isArray(reply?.data)) return { rows, complete: false };
      rows.push(...reply.data);
      if (!reply.links?.next) return { rows, complete: true };
      try { current = nextPage(reply.links.next, path); } catch { return { rows, complete: false }; }
    }
    return { rows, complete: false };
  }
  async function count(query) {
    const reply = await get('/v1/betaTesters', { ...query, limit: 1, 'fields[betaTesters]': 'inviteType' });
    if (!Array.isArray(reply?.data)) return null;
    const total = reply.meta?.paging?.total;
    if (Number.isSafeInteger(total) && total >= reply.data.length) return total;
    return reply.links?.next ? null : reply.data.length;
  }
  return { get, list, count };
}

function version(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersion(left, right) {
  const a = version(left), b = version(right);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return Math.sign((a[i] ?? 0) - (b[i] ?? 0));
  return 0;
}

function deviceCheck(minimum, observer) {
  if (!observer?.device_family || !observer?.os_version) return check('device', 'unknown', 'The device family and OS version have not been checked.');
  if (!knownFamilies.has(observer.device_family)) return check('device', 'blocked', 'This device family cannot join an Apple TestFlight beta.');
  const comparison = compareVersion(observer.os_version, minimum);
  if (comparison === null) return check('device', 'unknown', 'The build minimum OS or the device OS version could not be verified.');
  return comparison >= 0 ? check('device', 'ready', 'The device meets the build minimum OS.') : check('device', 'blocked', `This build requires OS ${minimum} or newer.`);
}

function buildChecksFor(build, beta, at, readState = null, number) {
  const attrs = build?.attributes ?? {};
  const external = beta?.data?.attributes?.externalBuildState;
  const expiration = typeof attrs.expirationDate === 'string' ? Date.parse(attrs.expirationDate) : NaN;
  return [
    readState ?? check('build', build?.id && (number == null || attrs.version === String(number)) ? 'ready' : 'unknown', build?.id ? 'The build was read from Apple.' : 'The build could not be verified.'),
    check('processing', attrs.processingState === 'VALID' ? 'ready' : ['PROCESSING', 'INVALID', 'FAILED'].includes(attrs.processingState) ? 'blocked' : 'unknown', attrs.processingState === 'VALID' ? 'Apple processed the upload.' : `Upload processing is ${attrs.processingState ?? 'unknown'}.`),
    check('expiration', attrs.expired === true || expiration <= at ? 'blocked' : attrs.expired === false && Number.isFinite(expiration) ? 'ready' : 'unknown', attrs.expired === true || expiration <= at ? 'This TestFlight build has expired.' : attrs.expired === false && Number.isFinite(expiration) ? 'This build is unexpired.' : 'Apple did not confirm that this build is unexpired.'),
    check('external_testing', external === 'IN_BETA_TESTING' ? 'ready' : externalStates.has(external) && !activationUnverified.has(external) ? 'blocked' : 'unknown', external === 'IN_BETA_TESTING' ? 'External testing is active for this build.' : `External testing is ${external ?? 'unknown'}; active tester access has not been verified.`),
  ];
}

function buildEvidence(build, beta) {
  const attrs = build?.attributes ?? {};
  return build?.id ? { id: build.id, number: attrs.version ?? null, processing_state: attrs.processingState ?? null, external_state: beta?.data?.attributes?.externalBuildState ?? null, expiration_date: attrs.expirationDate ?? null, expired: attrs.expired ?? null, min_os_version: attrs.minOsVersion ?? null, auto_notify_enabled: beta?.data?.attributes?.autoNotifyEnabled ?? null } : null;
}

async function activeGroupBuilds({ read, group, selectedId, betaCache, at }) {
  const listed = await read.list(`/v1/betaGroups/${encodeURIComponent(group.id)}/builds`, { 'fields[builds]': 'version,uploadedDate,expirationDate,expired,minOsVersion,processingState' });
  const candidates = new Map(listed.rows.filter(row => row?.id).map(row => [row.id, row]));
  let complete = listed.complete && listed.rows.every(row => row?.id);
  const ordered = [...candidates.values()].sort((a, b) => (Date.parse(b.attributes?.uploadedDate) || 0) - (Date.parse(a.attributes?.uploadedDate) || 0));
  const pending = [];
  for (const build of ordered) {
    const preliminary = buildChecksFor(build, null, at).filter(row => row.name !== 'external_testing');
    if (stateOf(preliminary) === 'blocked') continue;
    if (stateOf(preliminary) === 'unknown') { complete = false; continue; }
    if (!betaCache.has(build.id)) {
      if (pending.length >= MAX_BUILD_DETAILS) { complete = false; continue; }
      pending.push(build);
    }
  }
  await Promise.all(pending.map(async build => betaCache.set(build.id, await read.get(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`))));
  const active = [], invitationCandidates = [];
  let activationUncertain = false;
  for (const build of ordered) {
    const beta = betaCache.get(build.id), checks = buildChecksFor(build, beta, at);
    const external = beta?.data?.attributes?.externalBuildState;
    const state = stateOf(checks);
    if (state === 'ready') active.push({ build, beta, checks });
    else if (state === 'unknown' && activationUnverified.has(external) && stateOf(checks.filter(row => row.name !== 'external_testing')) === 'ready') activationUncertain = true;
    else if (state === 'unknown') complete = false;
    if ((external === 'IN_BETA_TESTING' || activationUnverified.has(external)) && stateOf(checks.filter(row => row.name !== 'external_testing')) === 'ready') invitationCandidates.push({ build, beta });
  }
  return { active, invitationCandidates, complete, activationUncertain, listed_complete: listed.complete, selected_assigned: selectedId ? candidates.has(selectedId) : null };
}

function requirements(minimum, filters) {
  // These are distribution constraints, not proof of every binary/hardware capability. A null family means
  // no additional public recruitment restriction; consumers still apply the product's supported device family.
  const base = { scope: 'minimum_os_and_public_recruitment', known: false, alternatives: [] };
  if (!version(minimum) || !Array.isArray(filters)) return base;
  if (!filters.length) return { ...base, known: true, alternatives: [{ device_family: null, minimum_os: minimum, maximum_os: null }] };
  const alternatives = [];
  for (const filter of filters) {
    if (!knownFamilies.has(filter?.deviceFamily)) return base;
    const min = filter.minimumOsInclusive == null ? minimum : compareVersion(minimum, filter.minimumOsInclusive) === null ? null : compareVersion(minimum, filter.minimumOsInclusive) >= 0 ? minimum : filter.minimumOsInclusive;
    const max = filter.maximumOsInclusive ?? null;
    if (!min || (max !== null && !version(max))) return base;
    if (max === null || compareVersion(min, max) <= 0) alternatives.push({ device_family: filter.deviceFamily, minimum_os: min, maximum_os: max });
  }
  return { ...base, known: true, alternatives };
}

async function recruitmentChecks(read, group, observer) {
  const prefix = `/v1/betaGroups/${encodeURIComponent(group.id)}`;
  let relation = group.relationships?.betaRecruitmentCriteria;
  if (!relation || !Object.hasOwn(relation, 'data')) relation = await read.get(`${prefix}/relationships/betaRecruitmentCriteria`);
  if (relation?.data === null) return { filters: [], distribution: check('recruitment', 'ready', 'The public link has no recruitment criteria.'), eligibility: check('recruitment_device', 'ready', 'No additional public-link device restrictions apply.') };
  if (!relation?.data?.id) return { filters: null, distribution: check('recruitment', 'unknown', 'Apple did not confirm whether public-link recruitment is restricted.'), eligibility: check('recruitment_device', 'unknown', 'The public-link device restrictions are unknown.') };
  const [criteria, compatible] = await Promise.all([
    read.get(`${prefix}/betaRecruitmentCriteria`),
    read.get(`${prefix}/betaRecruitmentCriterionCompatibleBuildCheck`),
  ]);
  const filters = criteria?.data?.attributes?.deviceFamilyOsVersionFilters;
  const hasBuild = compatible?.data?.attributes?.hasCompatibleBuild;
  const distribution = check('recruitment', hasBuild === false ? 'blocked' : hasBuild === true ? 'ready' : 'unknown', hasBuild === false ? 'Apple reports no build compatible with this public link’s criteria.' : hasBuild === true ? 'Apple reports a build compatible with the public-link criteria.' : 'Apple did not confirm a build compatible with the public-link criteria.');
  if (!Array.isArray(filters) || !filters.length) return { filters: null, distribution, eligibility: check('recruitment_device', 'unknown', 'The public-link criteria could not be read.') };
  if (!observer?.device_family || !version(observer?.os_version)) return { filters, distribution, eligibility: check('recruitment_device', 'unknown', 'This public link restricts devices; the person’s device has not been checked.') };
  let malformed = false;
  const matches = filters.some(filter => {
    if (!knownFamilies.has(filter?.deviceFamily)) { malformed = true; return false; }
    if (filter.deviceFamily !== observer.device_family) return false;
    const low = filter.minimumOsInclusive == null ? 1 : compareVersion(observer.os_version, filter.minimumOsInclusive);
    const high = filter.maximumOsInclusive == null ? -1 : compareVersion(observer.os_version, filter.maximumOsInclusive);
    if (low === null || high === null) { malformed = true; return false; }
    return low >= 0 && high <= 0;
  });
  return { filters, distribution, eligibility: check('recruitment_device', matches ? 'ready' : malformed ? 'unknown' : 'blocked', matches ? 'The device matches the public-link recruitment criteria.' : malformed ? 'A recruitment criterion could not be interpreted.' : 'The device does not match this public link’s recruitment criteria.') };
}

function publicLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'testflight.apple.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/join\/[a-zA-Z0-9]+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

/** Read-only. `number` names a build number, not a marketing version. Without an id or number, selection is the
 * latest upload. Route availability separately considers assigned builds in each configured external group.
 * `observer` is {device_family: Apple's DeviceFamily, os_version}; absent observations remain unknown.
 * `testerId`, when supplied, is an already resolved Apple tester id. Email observations are omitted otherwise.
 * Ready means these distribution/recruitment prerequisites are met, never installation, sign-in or all hardware
 * capabilities. Consumers also apply the product's supported family and native capability requirements.
 */
export async function readTestFlightAvailability({ asc, appId, testflight, buildId, number, observer, testerId, now = new Date(), validForMs = MAX_AGE_MS }) {
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) throw new Error('A valid observation time is required.');
  if (typeof appId !== 'string' || !appId) throw new Error('An app id is required.');
  if (testflight?.groups != null && !Array.isArray(testflight.groups)) throw new Error('TestFlight groups must be an array.');
  const wanted = [...new Set(testflight?.groups ?? [])];
  if (wanted.some(name => typeof name !== 'string' || !name)) throw new Error('TestFlight group names must be non-empty strings.');
  const errors = [], read = reader(asc, errors);
  const checked_at = new Date(at).toISOString();
  const expires_at = new Date(at + Math.min(MAX_AGE_MS, Number.isFinite(validForMs) && validForMs > 0 ? validForMs : MAX_AGE_MS)).toISOString();
  const hasNumber = number != null && number !== '';
  const report = { schema: 'trillion.testflight-readiness/v1', app_id: appId, selection: buildId || hasNumber ? 'specific_build' : 'latest_upload', route_scope: 'configured_group', checked_at, expires_at, installation_verified: false, build: null, groups: [], routes: [], errors };
  const groups = await read.list('/v1/betaGroups', { 'filter[app]': appId });
  let build, buildReadState;
  if (buildId) {
    const [got, owner] = await Promise.all([read.get(`/v1/builds/${encodeURIComponent(buildId)}`), read.get(`/v1/builds/${encodeURIComponent(buildId)}/app`, { 'fields[apps]': 'bundleId' })]);
    build = got?.data;
    buildReadState = owner?.data?.id === appId ? null : check('build', owner?.data?.id ? 'blocked' : 'unknown', owner?.data?.id ? 'This build belongs to a different app.' : 'Apple did not confirm this build belongs to the requested app.');
  } else {
    const reply = await read.get('/v1/builds', { 'filter[app]': appId, ...(hasNumber ? { 'filter[version]': String(number), limit: 2 } : { sort: '-uploadedDate', limit: 1 }) });
    if (!Array.isArray(reply?.data)) buildReadState = check('build', 'unknown', 'Apple did not return the selected build.');
    else if (!reply.data.length) buildReadState = check('build', 'blocked', 'Apple has no matching uploaded build.');
    else if (hasNumber && (reply.data.length > 1 || reply.links?.next)) buildReadState = check('build', 'unknown', 'This build number is ambiguous; select an exact build id.');
    else build = reply.data[0];
  }
  const beta = build?.id ? await read.get(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`) : null;
  report.build = buildEvidence(build, beta);
  const buildChecks = buildChecksFor(build, beta, at, buildReadState, hasNumber ? number : undefined);
  report.selected_build_state = stateOf(buildChecks);
  report.selected_build_checks = buildChecks;
  const betaCache = new Map(build?.id ? [[build.id, beta]] : []);
  const appCount = wanted.some(name => groups.rows.some(g => g.attributes?.name === name && g.attributes?.isInternalGroup === false)) ? await read.count({ 'filter[apps]': appId }) : null;
  for (const name of wanted) {
    const matches = groups.rows.filter(group => group.attributes?.name === name);
    const group = matches.length === 1 && groups.complete ? matches[0] : null;
    const id = group?.id ?? `unresolved:${name}`;
    const groupCheck = !group ? check('group', matches.length > 1 || !groups.complete ? 'unknown' : 'blocked', matches.length > 1 ? 'The configured group name is ambiguous.' : groups.complete ? `The configured TestFlight group "${name}" does not exist.` : 'The configured group could not be verified.') : check('group', group.attributes?.isInternalGroup === false ? 'ready' : group.attributes?.isInternalGroup === true ? 'blocked' : 'unknown', group.attributes?.isInternalGroup === false ? 'The configured group accepts external testers.' : 'This group has not been verified as an external testing group.');
    const groupReport = { id: group?.id ?? null, name, is_internal: group?.attributes?.isInternalGroup ?? null, selected_build_association: 'unknown', candidate_scan_complete: null, active_build_ids: [], invitation_candidates: [], app_capacity_state: appCount !== null && appCount < EXTERNAL_TESTER_LIMIT ? 'ready' : 'unknown' };
    report.groups.push(groupReport);
    function route(channel, candidate, distribution, eligibility, filters, action = null, evidence = {}) {
      const checks = [...distribution, ...eligibility], state = stateOf(checks);
      const attrs = candidate?.build?.attributes ?? {};
      const expiration = Date.parse(attrs.expirationDate);
      const routeExpiry = Number.isFinite(expiration) ? new Date(Math.max(at, Math.min(Date.parse(expires_at), expiration))).toISOString() : expires_at;
      report.routes.push({ id: `testflight-${channel === 'public_link' ? 'public' : 'email'}:${id}:${candidate?.build?.id ?? 'unverified'}`, channel, scope: 'configured_group', group_id: group?.id ?? null, group_name: name, build_id: candidate?.build?.id ?? null, build_number: attrs.version ?? null, build_expiration_date: attrs.expirationDate ?? null, min_os_version: attrs.minOsVersion ?? null, state, distribution_state: stateOf(distribution), eligibility_state: stateOf(eligibility), reason: reasonOf(checks), checked_at, expires_at: routeExpiry, action: state === 'ready' ? action : null, eligibility_requirements: requirements(attrs.minOsVersion, filters), checks, evidence });
    }
    const unavailable = (state, reason) => {
      const common = [groupCheck, check('available_build', state, reason)];
      route('public_link', null, common, [check('device', 'unknown', 'No active build has been verified for these device requirements.')], null);
      if (testerId) route('email', null, common, [check('email_tester', 'unknown', 'Tester access has not been checked against an active build.')], null);
    };
    if (groupCheck.state !== 'ready') { unavailable(groupCheck.state, groupCheck.reason); continue; }
    const candidates = await activeGroupBuilds({ read, group, selectedId: build?.id, betaCache, at });
    groupReport.selected_build_association = candidates.selected_assigned === true ? 'ready' : build?.id && candidates.listed_complete ? 'blocked' : 'unknown';
    groupReport.candidate_scan_complete = candidates.complete;
    groupReport.active_build_ids = candidates.active.map(row => row.build.id);
    // These facts authorize no send by themselves. An invitation owner must separately resolve the recipient,
    // membership, device family, capacity and prior delivery before choosing an enrollment/invitation operation.
    groupReport.invitation_candidates = candidates.invitationCandidates.map(({ build, beta }) => ({ build_id: build.id, external_state: beta.data.attributes.externalBuildState, auto_notify_enabled: beta.data.attributes.autoNotifyEnabled ?? null, min_os_version: build.attributes.minOsVersion ?? null, expires_at: new Date(Math.min(Date.parse(expires_at), Date.parse(build.attributes.expirationDate))).toISOString(), eligibility_state: deviceCheck(build.attributes.minOsVersion, observer).state, eligibility_requirements: requirements(build.attributes.minOsVersion, []) }));
    if (!candidates.complete || candidates.activationUncertain || !candidates.active.length) unavailable(candidates.complete && !candidates.activationUncertain ? 'blocked' : 'unknown', !candidates.complete ? 'The bounded group-build read is incomplete; another usable build may exist.' : candidates.activationUncertain ? 'Apple approval is recorded, but activation or first-tester access has not been verified.' : 'Apple has no active, unexpired external build assigned to this group.');
    if (!candidates.active.length) continue;
    const ga = group.attributes;
    const href = publicLink(ga.publicLink);
    const enabled = check('public_link', ga.publicLinkEnabled === false ? 'blocked' : ga.publicLinkEnabled === true && href ? 'ready' : 'unknown', ga.publicLinkEnabled === false ? 'This public TestFlight link is disabled.' : ga.publicLinkEnabled === true && href ? 'Apple confirms this public TestFlight link is enabled.' : 'Apple did not provide an enabled, valid public TestFlight link.');
    const publicCount = ga.publicLinkLimitEnabled === true ? await read.count({ 'filter[apps]': appId, 'filter[betaGroups]': group.id, 'filter[inviteType]': 'PUBLIC_LINK' }) : null;
    const validLimit = Number.isInteger(ga.publicLinkLimit) && ga.publicLinkLimit >= 1 && ga.publicLinkLimit <= EXTERNAL_TESTER_LIMIT;
    const groupCapacity = ga.publicLinkLimitEnabled === false ? check('public_capacity', 'ready', 'This group has no separate public-link tester limit.') : ga.publicLinkLimitEnabled === true && validLimit && publicCount !== null ? check('public_capacity', publicCount < ga.publicLinkLimit ? 'ready' : 'blocked', publicCount < ga.publicLinkLimit ? 'The public-link group has space for another tester.' : 'The public-link tester limit has been reached.') : check('public_capacity', 'unknown', 'Public-link tester capacity could not be verified.');
    // The app count can include internal testers. Below 10,000 proves room; a greater count cannot prove external fullness.
    const appCapacity = check('app_capacity', appCount !== null && appCount < EXTERNAL_TESTER_LIMIT ? 'ready' : 'unknown', appCount !== null && appCount < EXTERNAL_TESTER_LIMIT ? 'The app has room below Apple’s external tester limit.' : 'Apple’s remaining external tester capacity has not been verified.');
    const recruitment = await recruitmentChecks(read, group, observer);
    let email, testerState = null;
    if (testerId) {
      const found = await read.list('/v1/betaTesters', { 'filter[apps]': appId, 'filter[betaGroups]': group.id, 'filter[id]': testerId, 'filter[inviteType]': 'EMAIL', 'fields[betaTesters]': 'state,inviteType' });
      const tester = found.rows.find(row => row.id === testerId && row.attributes?.inviteType === 'EMAIL');
      testerState = tester?.attributes?.state ?? null;
      email = !tester ? check('email_tester', found.complete ? 'blocked' : 'unknown', found.complete ? 'This tester has no email invitation membership in the configured group.' : 'The tester’s group membership could not be verified.') : ['ACCEPTED', 'INSTALLED'].includes(testerState) ? check('email_tester', 'ready', 'The named email tester accepted access to this group.') : ['NOT_INVITED', 'REVOKED'].includes(testerState) ? check('email_tester', 'blocked', `The named tester’s access is ${testerState}.`) : check('email_tester', 'unknown', testerState === 'INVITED' ? 'Apple records an invitation, but receipt and acceptance have not been verified.' : 'The named tester’s invitation state is unknown.');
    }
    for (const candidate of candidates.active) {
      const common = [groupCheck, ...candidate.checks, check('build_association', 'ready', 'Apple confirms this build is assigned to the configured group.')];
      const device = deviceCheck(candidate.build.attributes?.minOsVersion, observer);
      route('public_link', candidate, [...common, enabled, groupCapacity, appCapacity, recruitment.distribution], [device, recruitment.eligibility], recruitment.filters, { href }, { public_link: href, public_link_enabled: ga.publicLinkEnabled ?? null, public_link_limit: ga.publicLinkLimit ?? null, public_link_testers: publicCount, app_testers_upper_bound: appCount, recruitment_filters: recruitment.filters, external_state: candidate.beta?.data?.attributes?.externalBuildState ?? null });
      if (testerId) route('email', candidate, common, [device, email], [], { kind: 'open_testflight', app_id: appId }, { tester_checked: true, tester_state: testerState, invitation_send_performed: false });
    }
  }
  report.state = report.routes.some(row => row.state === 'ready') ? 'ready' : report.routes.length && report.routes.every(row => row.state === 'blocked') ? 'blocked' : 'unknown';
  report.distribution_state = report.routes.some(row => row.distribution_state === 'ready') ? 'ready' : report.routes.length && report.routes.every(row => row.distribution_state === 'blocked') ? 'blocked' : 'unknown';
  report.reason = wanted.length ? 'Routes concern available builds in configured groups; selected upload readiness is reported separately. Installation and native sign-in require their own evidence.' : 'No TestFlight groups are configured in this app’s listing.';
  return report;
}
