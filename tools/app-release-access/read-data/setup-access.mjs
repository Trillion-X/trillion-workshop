// tools/app-release-access/read-data/setup-access.mjs (moved from old trillion computer/setup-access.mjs)
//
// The container tool `tool:fulfill-setup-access`: fulfil a server-authorized setup request with the release owner's
// held App Store Connect key. Input names an account request (and the app it is for), never a recipient. The
// operator's claim resolves consent, current setup, policy and verified email; a durable checkpoint precedes each
// provider mutation; ambiguous attempts are read back, never blindly resent.
//
// The claim, checkpoint and finish are the release owner's setup-access operations. The old host called them at the
// account's /mcp/api/setup-access route; the engine has no such operation at the records door yet (README "Not yet"),
// so the default operator refuses before any provider call. fulfillAppleSetupAccess is the provider adapter itself.
//
// Apple primary protocol references (checked 2026-10-08):
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-betatesters
// https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betatesters
// https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-betatesters
// https://developer.apple.com/documentation/appstoreconnectapi/beta-tester-invitations
// https://developer.apple.com/documentation/appstoreconnectapi/betatesterinvitationcreaterequest
import settings from './setup-access.json' with { type: 'json' };
import { distributionSource } from './distribution.mjs';
import { appStoreConnect, readHeldKey } from './app-store-connect.mjs';
import { readTestFlightAvailability } from './testflight-readiness.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim();
const normalizeEmail = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const providerStates = new Set(['NOT_INVITED', 'INVITED', 'ACCEPTED', 'INSTALLED', 'REVOKED']);
const candidateStates = new Set(['IN_BETA_TESTING', 'READY_FOR_BETA_TESTING', 'BETA_APPROVED']);
const result = (state, reason, extra = {}) => ({ state, reason, ...extra });
const problem = (reason, blocker = 'provider-prerequisite-unverified', extra = {}) => result('blocked', reason, { blocker, ...extra });
const safeStatus = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : null;
const readFailure = error => result('indeterminate', `Apple could not confirm the access state${safeStatus(error) ? ` (HTTP ${safeStatus(error)})` : ''}. Retry checks its current state before changing anything.`, { blocker: 'provider-read-unconfirmed' });

async function bounded(call) {
  let timer;
  try { return await Promise.race([call(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('provider-timeout')), 15000); })]); }
  finally { clearTimeout(timer); }
}

function validReport(report, appId, now) {
  return report?.app_id === appId && Number.isFinite(Date.parse(report.checked_at)) && Date.parse(report.checked_at) <= now + 15000 &&
    Date.parse(report.expires_at) > now && Date.parse(report.expires_at) <= Date.parse(report.checked_at) + 300000;
}

function publicAction(report, source, now) {
  for (const route of report.routes ?? []) {
    if (route.channel !== 'public_link' || route.state !== 'ready' || route.distribution_state !== 'ready' || route.eligibility_state !== 'ready' || Date.parse(route.expires_at) <= now || !Number.isFinite(Date.parse(route.expires_at)) || Date.parse(route.expires_at) > Date.parse(report.expires_at)) continue;
    try {
      const url = new URL(route.action?.href);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && source.allowed_hosts.includes(url.hostname)) return {
        action: { href: url.href, label: route.action.label || 'Join the beta' },
        availability: { checked_at: report.checked_at, expires_at: route.expires_at },
      };
    } catch { /* Only the provider's validated, usable route can replace an invitation. */ }
  }
  return null;
}

async function exactTester(asc, email) {
  const reply = await bounded(() => asc.get('/v1/betaTesters', { query: { 'filter[email]': email, limit: 2, 'fields[betaTesters]': 'email,state,inviteType' } }));
  if (!Array.isArray(reply?.data) || reply.links?.next || reply.data.length > 1 || reply.data.some(row => row.type !== 'betaTesters' || !id(row.id) || normalizeEmail(row.attributes?.email) !== email)) throw new Error('tester-lookup-unverified');
  return reply.data[0] ?? null;
}

async function membership(asc, { appId, groupId, testerId }) {
  const reply = await bounded(() => asc.get('/v1/betaTesters', { query: { 'filter[apps]': appId, 'filter[betaGroups]': groupId, 'filter[id]': testerId, 'filter[inviteType]': 'EMAIL', limit: 2, 'fields[betaTesters]': 'state,inviteType' } }));
  if (!Array.isArray(reply?.data) || reply.links?.next || reply.data.length > 1 || reply.data.some(row => row.type !== 'betaTesters' || row.id !== testerId || row.attributes?.inviteType !== 'EMAIL')) throw new Error('membership-unverified');
  return reply.data[0] ?? null;
}

function stateResult(member, details) {
  const state = member?.attributes?.state;
  if (!providerStates.has(state)) return null;
  const values = { ...details, provider_state: state };
  if (state === 'INVITED') return result('invited', 'Apple records an invitation to your verified account email. Open that invitation to accept TestFlight access.', values);
  if (state === 'ACCEPTED') return result('accepted', 'Apple records that you accepted access. Open TestFlight to install Trillion, then sign in to finish this requirement.', values);
  if (state === 'INSTALLED') return result('installed', 'Apple reports a beta installation. Trillion still checks its own app sign-in before completing setup.', values);
  if (state === 'REVOKED') return result('revoked', settings.words.revoked, { ...values, blocker: 'provider-access-revoked' });
  return null;
}

function mutationFailure(error, mutation, details) {
  const status = safeStatus(error);
  const refused = status !== null && status < 500 && status !== 408;
  return result(refused ? 'blocked' : 'indeterminate', refused ? `Apple refused the access operation (HTTP ${status}). An explicit retry rechecks the current request and provider state.` : 'Apple did not confirm the access operation. A retry will read the tester state; it will not send another uncertain invitation.', {
    ...details, blocker: refused ? 'provider-refused' : 'provider-mutation-unconfirmed',
    mutation_outcomes: { [mutation]: { state: refused ? 'refused' : 'indeterminate', http_status: status } },
  });
}

/** Testable provider adapter. The caller must obtain dispatch from an authenticated server claim. */
export async function fulfillAppleSetupAccess({ asc, dispatch, listing, source, checkpoint, readAvailability = readTestFlightAvailability, now = Date.now }) {
  const recipient = normalizeEmail(dispatch?.recipient?.email);
  if (!recipient || dispatch.recipient.verified !== true || dispatch.policy?.provider !== 'apple-testflight' || dispatch.policy.operation !== 'invite' ||
      !listing?.testflight?.groups?.includes(dispatch.policy.group_name) || typeof checkpoint !== 'function') return problem('The signed-in access request or configured provider policy could not be verified.', 'request-policy-unverified');
  let appId, group, report, tester, member;
  const outcomes = {};
  let details = {};
  try {
    const apps = await bounded(() => asc.get('/v1/apps', { query: { 'filter[bundleId]': listing.app.bundle_identifier, limit: 2 } }));
    if (!Array.isArray(apps?.data) || apps.links?.next || apps.data.length !== 1 || apps.data[0]?.attributes?.bundleId !== listing.app.bundle_identifier || !id(apps.data[0].id)) return problem('The configured app did not resolve to one Apple app record.');
    appId = apps.data[0].id;
    details = { app_id: appId };
    report = await readAvailability({ asc, appId, testflight: { ...listing.testflight, groups: [dispatch.policy.group_name] }, observer: dispatch.observer, now: now() });
    if (!validReport(report, appId, now())) return problem('Apple distribution evidence is missing or expired. Check it again.', 'distribution-stale', details);
    const observerIsTarget = source.product_families?.includes(dispatch.observer?.device_family);
    const route = observerIsTarget ? publicAction(report, source, now()) : null;
    if (route) return result('available', 'Apple confirms that a public installation route is usable. Open it to continue; no email invitation is needed.', { ...details, ...route });
    const groups = (report.groups ?? []).filter(row => row.name === dispatch.policy.group_name);
    if (groups.length !== 1 || !id(groups[0].id) || groups[0].is_internal !== false) return problem('The configured external tester group could not be verified.', 'external-group-unverified', details);
    group = groups[0];
    details.group_id = group.id;
    const candidates = (group.invitation_candidates ?? []).filter(row => id(row.build_id) && candidateStates.has(row.external_state) && Date.parse(row.expires_at) > now());
    if (!candidates.length) return problem(group.candidate_scan_complete ? 'No processed, unexpired build approved for external tester access is assigned to this group.' : 'Apple did not finish confirming a build suitable for an invitation.', 'external-build-unverified', details);
    if (observerIsTarget && candidates.every(row => row.eligibility_state === 'blocked')) return problem('Your observed iPhone software does not meet the available beta requirements. Update it or use a compatible device, then check access again.', 'device-incompatible', details);
    if (dispatch.policy.require_device_eligibility === true && (!observerIsTarget || !candidates.some(row => row.eligibility_state === 'ready'))) return problem('The access policy requires a compatible target device to be checked first.', 'device-eligibility-unverified', details);
    const freshCandidates = () => candidates.filter(row => Date.parse(row.expires_at) > now() && (!observerIsTarget || row.eligibility_state !== 'blocked') && (dispatch.policy.require_device_eligibility !== true || row.eligibility_state === 'ready'));
    tester = await exactTester(asc, recipient);
    if (tester) {
      details.tester_id = tester.id;
      member = await membership(asc, { appId, groupId: group.id, testerId: tester.id });
      const known = stateResult(member, details);
      if (known) return known;
      if (tester.attributes?.state === 'REVOKED') return stateResult(tester, details);
    }
    // Unknown future phone details do not prevent a consented invitation. They do prevent claiming install readiness.
    if (!member) {
      if (group.app_capacity_state !== 'ready') return problem('Apple has not confirmed room for another tester. The release owner needs to resolve capacity first.', 'tester-capacity-unverified', details);
      if (!validReport(report, appId, now()) || !freshCandidates().length) return problem('The distribution check or compatible build expired before enrollment. Retry to check it again.', 'distribution-stale', details);
      const permit = await checkpoint('enroll');
      if (permit?.allowed !== true) return result('indeterminate', 'An enrollment was already attempted. Apple has not confirmed its membership yet; no duplicate invitation was started.', { ...details, blocker: 'enrollment-unconfirmed' });
      if (!validReport(report, appId, now()) || !freshCandidates().length) return problem('The verified build expired before enrollment could start. Retry to check it again.', 'distribution-stale', { ...details, mutation_outcomes: { enroll: { state: 'not-started' } } });
      try {
        if (!tester) {
          const created = await bounded(() => asc.post('/v1/betaTesters', { data: { type: 'betaTesters', attributes: { email: recipient }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } } }, [201]));
          if (!id(created?.data?.id) || created.data.type !== 'betaTesters') throw new Error('tester-created-unconfirmed');
          details.tester_id = created.data.id;
        } else {
          await bounded(() => asc.post(`/v1/betaGroups/${encodeURIComponent(group.id)}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: tester.id }] }, [204]));
        }
        outcomes.enroll = { state: 'observed' };
      } catch (error) {
        // A concurrent create can be reconciled by exact mailbox and scoped membership; it never chooses a second tester.
        if (safeStatus(error) === 409) {
          try {
            tester = await exactTester(asc, recipient);
            member = tester ? await membership(asc, { appId, groupId: group.id, testerId: tester.id }) : null;
            if (tester && member) { details.tester_id = tester.id; outcomes.enroll = { state: 'observed' }; }
            else return mutationFailure(error, 'enroll', details);
          } catch { return mutationFailure(error, 'enroll', details); }
        } else return mutationFailure(error, 'enroll', details);
      }
      if (!member) {
        tester = await exactTester(asc, recipient);
        if (!tester || (details.tester_id && tester.id !== details.tester_id)) return result('indeterminate', 'Apple has not confirmed the tester identity after enrollment. No additional invitation was started.', { ...details, blocker: 'tester-readback-unconfirmed', mutation_outcomes: outcomes });
        details.tester_id = tester.id;
        member = await membership(asc, { appId, groupId: group.id, testerId: tester.id });
      }
    }
    const known = stateResult(member, details);
    if (known) return { ...known, mutation_outcomes: outcomes };
    if (member?.attributes?.state !== 'NOT_INVITED') return result('indeterminate', 'Apple has not confirmed the tester group and invitation state yet. Check this same request again.', { ...details, blocker: 'membership-readback-unconfirmed', mutation_outcomes: outcomes });
    // Apple sends when the tester is added to a ready group with automatic notification. The invitation API is
    // also a resend endpoint: call it only for a known first send when every candidate explicitly disables auto-notify.
    if (!freshCandidates().length || !validReport(report, appId, now())) return problem('The provider readiness check or compatible build expired before the invitation. Retry to recheck it.', 'distribution-stale', { ...details, mutation_outcomes: outcomes });
    if (!freshCandidates().every(row => row.auto_notify_enabled === false)) return result('awaiting-invitation', 'Tester membership exists, but Apple has not yet recorded the automatic invitation. Check again; an email has not been assumed sent.', { ...details, provider_state: 'NOT_INVITED', mutation_outcomes: outcomes });
    const permit = await checkpoint('send-invitation');
    if (permit?.allowed !== true) return result('indeterminate', 'An invitation send was already attempted. Apple has not yet confirmed it; no second email was sent.', { ...details, blocker: 'invitation-unconfirmed', provider_state: 'NOT_INVITED', mutation_outcomes: outcomes });
    if (!validReport(report, appId, now()) || !freshCandidates().length) return problem('The verified build expired before the invitation could start. Retry to check it again.', 'distribution-stale', { ...details, mutation_outcomes: { ...outcomes, 'send-invitation': { state: 'not-started' } } });
    try {
      const invitation = await bounded(() => asc.post('/v1/betaTesterInvitations', { data: { type: 'betaTesterInvitations', relationships: { app: { data: { type: 'apps', id: appId } }, betaTester: { data: { type: 'betaTesters', id: details.tester_id } } } } }, [201]));
      if (id(invitation?.data?.id)) details.invitation_id = invitation.data.id;
      outcomes['send-invitation'] = { state: 'observed' };
    } catch (error) {
      const failure = mutationFailure(error, 'send-invitation', details);
      return { ...failure, mutation_outcomes: { ...outcomes, ...failure.mutation_outcomes } };
    }
    member = await membership(asc, { appId, groupId: group.id, testerId: details.tester_id });
    return { ...(stateResult(member, details) ?? result('awaiting-invitation', 'Apple accepted the invitation operation; its tester state has not yet confirmed delivery or acceptance.', { ...details, provider_state: member?.attributes?.state ?? null })), mutation_outcomes: outcomes };
  } catch (error) { return { ...readFailure(error), ...details, ...(Object.keys(outcomes).length ? { mutation_outcomes: outcomes } : {}) }; }
}

const NAMES = ['account_id', 'source_id', 'request_id'];
const noOperator = async () => {
  throw new Error('The release owner\'s setup-access claim, checkpoint and finish are not operations a tool run can reach at the records door yet. No provider action was taken.');
};

export function makeSetupAccessTools({ connect = appStoreConnect, readKey = readHeldKey, readAvailability = readTestFlightAvailability, operator = noOperator, now = Date.now } = {}) {
  return { async fulfill(input = {}) {
    if (!object(input) || Object.keys(input).some(name => ![...NAMES, 'bundle_identifier', 'testflight_groups'].includes(name)) || !NAMES.every(name => id(input[name]))) throw new Error('Name only the current account, source and access request. Recipients and provider destinations are resolved by the server.');
    const source = distributionSource(input.source_id);
    if (!source) throw new Error('The signed-in release owner and configured source are required.');
    if (!id(input.bundle_identifier) || !Array.isArray(input.testflight_groups) || !input.testflight_groups.every(id)) throw new Error('Name the app by its bundle identifier and its TestFlight groups.');
    const request = Object.fromEntries(NAMES.map(name => [name, input[name]]));
    const api = (operation, extra = {}) => operator(operation, { ...request, operation, ...extra });
    const dispatch = await api('claim');
    if (dispatch.authorized !== true) return { state: dispatch.state ?? 'blocked', reason: dispatch.reason ?? 'The current account request does not permit an invitation.', request_id: input.request_id };
    if (!NAMES.every(name => dispatch[name] === input[name]) || !id(dispatch.lease?.id) || Date.parse(dispatch.lease?.expires_at) <= now() || dispatch.mandate?.account_id !== input.account_id || dispatch.mandate?.by !== input.account_id || dispatch.mandate?.revoked === true) throw new Error('The operator claim did not resolve a current account mandate.');
    const checkpoint = async mutation => {
      if (Date.parse(dispatch.lease.expires_at) <= now()) throw new Error('The provider-action lease expired before a change.');
      return api('checkpoint', { lease_id: dispatch.lease.id, mutation });
    };
    let outcome;
    try {
      const listing = { app: { bundle_identifier: input.bundle_identifier }, testflight: { groups: input.testflight_groups } };
      if (dispatch.policy?.provider !== 'apple-testflight' || !listing.testflight.groups.includes(dispatch.policy.group_name)) outcome = problem('This request names no configured provider group.', 'policy-group-unconfigured');
      else {
        const asc = connect({ apiKey: readKey() });
        outcome = await fulfillAppleSetupAccess({ asc, dispatch, listing, source, checkpoint, readAvailability, now });
      }
    } catch { outcome = problem('The configured provider credential or local release configuration is unavailable.', 'provider-configuration-unavailable'); }
    return api('finish', { lease_id: dispatch.lease.id, result: outcome });
  } };
}

const tools = makeSetupAccessTools();
export const fulfill = input => tools.fulfill(input);
