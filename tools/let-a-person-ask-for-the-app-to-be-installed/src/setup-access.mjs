// Conditional setup access is release-owner work over existing workspace records and tools.
// The server supplies the actual requirement, verified email and recorded signup mandate.
// A customer body cannot choose a recipient, group, provider, completion state or tool.
// Provider mutations run only after a fresh operator-only claim and a durable checkpoint.
import settings from '../../set-up-my-account/read-data/setup-access.json' with { type: 'json' };
import devices from '../../set-up-my-devices-and-cameras/src/devices.json' with { type: 'json' };
import { distributionSource } from '../../set-up-my-devices-and-cameras/src/device-distribution.mjs';
import { workspaceValueIdentity } from '../../set-up-my-account/read-data/conflicts.mjs';

export const setupAccessSettings = settings;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const short = (value, limit = 200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const identity = value => value == null ? null : workspaceValueIdentity(value);
const email = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const keyPart = value => encodeURIComponent(value);
export const setupAccessRecordLabel = (accountId, sourceId) => settings.request_prefix + keyPart(accountId) + ':' + keyPart(sourceId);
const terminal = record => settings.terminal_states.includes(record?.state);
const at = now => new Date(now).toISOString();

function currentObserver(context) {
  const observer = context?.observer;
  if (!object(observer) || !/^[A-Z_]{1,40}$/.test(observer.device_family ?? '') || !/^\d+(?:\.\d+){0,3}$/.test(observer.os_version ?? '')) return null;
  return { device_family: observer.device_family, os_version: observer.os_version };
}

function keptObserver(record, now) {
  const hint = record?.observer_hint, observed = Date.parse(hint?.observed_at), expires = Date.parse(hint?.expires_at);
  if (!Number.isFinite(observed) || observed > now || !Number.isFinite(expires) || expires <= now || expires > observed + settings.observer_max_age_seconds * 1000) return null;
  return currentObserver({ observer: hint });
}

/** Persist this only alongside the accepted, versioned notice in a verified account-creation flow. */
export function signupAccessMandate({ version, userId, verifiedEmail, verifiedAt, now = Date.now() }) {
  const recipient = email(verifiedEmail), verified = Date.parse(verifiedAt);
  if (version !== settings.notice_version || !short(userId) || !recipient || !Number.isFinite(verified) || verified > now) return null;
  return { authorized: true, account_id: userId, recipient_identity: identity({ verified_email: recipient }),
    evidence_ref: `signup-access-notice:${settings.notice_version}`, at: at(now) };
}

async function policyFor(operator, sourceId) {
  const kept = await operator.workspaceRecord(settings.policy_record);
  const policy = object(kept?.sources) && Object.hasOwn(kept.sources, sourceId) ? kept.sources[sourceId] : null;
  if (!object(policy) || policy.enabled !== true || policy.operation !== 'invite' || !short(policy.provider) || !short(policy.group_name)) return null;
  return { enabled: true, operation: 'invite', provider: short(policy.provider), group_name: short(policy.group_name),
    require_device_eligibility: policy.require_device_eligibility === true,
    version: identity(policy), owner: short(policy.owner) || distributionSource(sourceId)?.owner || 'release-owner' };
}

function availabilityBounds(value, now) {
  const checked = Date.parse(value?.checked_at), expires = Date.parse(value?.expires_at);
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now + devices.distribution.clock_skew_seconds * 1000 ||
      expires <= checked || expires <= now || expires > checked + devices.distribution.max_age_seconds * 1000) return null;
  return { checked_at: new Date(checked).toISOString(), expires_at: new Date(expires).toISOString() };
}

function usableRoute(context, now) {
  const route = context?.usable_route;
  if (!object(route) || route.available !== true || route.state !== 'ready') return null;
  const availability = availabilityBounds(route, now);
  if (!availability) return null;
  try {
    const url = new URL(route.href);
    const source = distributionSource(context.source_id);
    return source && url.protocol === 'https:' && !url.username && !url.password && source.allowed_hosts.includes(url.hostname)
      ? { action: { label: short(route.label) || 'Open app access', href: url.href }, availability } : null;
  } catch { return null; }
}

const keptRoute = (record, now) => usableRoute({ source_id: record?.source_id,
  usable_route: { ...record?.action, ...record?.availability, available: true, state: 'ready' } }, now);

function mandateFor(context, record, userId, recipientIdentity, consent, now) {
  if (consent === true) return { by: userId, account_id: userId, recipient_identity: recipientIdentity, basis: 'authenticated-access-request', at: at(now) };
  const existing = record?.mandate;
  if (existing?.revoked === true) return null;
  if (existing?.by === userId && existing.account_id === userId && existing.recipient_identity === recipientIdentity) return existing;
  const given = context?.mandate;
  // The callback is a server capability, not request data. Signup consent must name its evidence.
  if (given?.authorized === true && given.account_id === userId && given.recipient_identity === recipientIdentity && short(given.evidence_ref) && given.revoked !== true) {
    return { by: userId, account_id: userId, recipient_identity: recipientIdentity, basis: 'recorded-signup-consent', evidence_ref: short(given.evidence_ref, 400), at: short(given.at) || at(now) };
  }
  return null;
}

async function evaluate({ operator, userId, sourceId, context, record, consent = false, now }) {
  const source = distributionSource(sourceId);
  if (!source) throw Object.assign(new Error('Name a configured setup access source.'), { status: 400 });
  if (!object(context) || context.source_id !== sourceId) throw Object.assign(new Error('The account setup context could not be verified.'), { status: 503 });
  const route = usableRoute(context, now);
  if (context.completed === true) return { state: 'installed', reason: 'Current owner facts already provide access.', action: null, source };
  if (context.setup_paused === true) return { state: 'blocked', reason: settings.words.setup_paused, blocker: 'setup-paused', source };
  if (route) return { state: 'available', reason: 'Current owner facts already provide access.', ...route, source };
  if (context.required !== true || context.applicable !== true) return { state: 'blocked', reason: settings.words.not_required, blocker: 'not-required', source };
  const policy = await policyFor(operator, sourceId);
  if (!policy) return { state: 'blocked', reason: settings.words.policy_missing, blocker: 'policy-missing', source };
  const recipient = email(context.verified_email);
  if (!recipient) return { state: 'blocked', reason: settings.words.email_missing, blocker: 'verified-email-missing', source, policy };
  const recipientIdentity = identity({ verified_email: recipient });
  const mandate = mandateFor(context, record, userId, recipientIdentity, consent, now);
  if (!mandate) return { state: 'blocked', reason: settings.words.mandate_missing, blocker: 'mandate-missing', source, policy, recipientIdentity };
  return { state: 'prepared', reason: settings.words.prepared, source, policy, recipient, recipientIdentity, mandate,
    observer: currentObserver(context) ?? keptObserver(record, now) };
}

async function save(operator, label, before, next) {
  const result = await operator.putWorkspaceRecords([{ address_label: label, payload: next, expected_identity: identity(before) }]);
  if (result?.ok === false || result?.refused || result?.conflicts?.length) throw Object.assign(new Error('This access request changed. Read it again.'), { status: 409 });
  const after = await operator.workspaceRecord(label);
  if (identity(after) !== identity(next)) throw Object.assign(new Error('The saved access request could not be confirmed.'), { status: 409 });
  return after;
}

function changed(before, patch, now) {
  const history = [...(Array.isArray(before?.history) ? before.history : []), ...(before ? [{ state: before.state, at: before.changed_at, reason: before.reason ?? null }] : [])].slice(-settings.history_limit);
  return { ...before, ...patch, changed_at: at(now), history };
}

export function setupAccessProjection(record, now = Date.now()) {
  if (!record) return { state: 'absent', request_id: null };
  const route = record.state === 'available' ? keptRoute(record, now) : null;
  const stale = record.state === 'available' && !route;
  const deadlines = [Date.parse(record.lease?.expires_at), Date.parse(route?.availability.expires_at)].filter(deadline => Number.isFinite(deadline) && deadline > now);
  return { account_id: record.account_id, source_id: record.source_id, request_id: record.request_id, state: stale ? 'unknown' : record.state,
    reason: stale ? settings.words.availability_stale : record.reason ?? null, blocker: stale ? 'distribution-stale' : record.blocker ?? null,
    action: route?.action ?? null, availability: route?.availability ?? null,
    provider_state: record.provider?.state ?? null, provider_installation_reported: record.provider?.state === 'INSTALLED',
    changed_at: record.changed_at, retry_at: deadlines.length ? at(Math.min(...deadlines)) : null, identity: identity(record),
    screen_update_pending: record.invalidation?.state === 'pending' };
}

const visibleIdentity = (record, now) => {
  const { identity: _identity, changed_at: _changed, screen_update_pending: _pending, ...visible } = setupAccessProjection(record, now);
  return identity(visible);
};

// This callback wakes the person's existing screens via a safe record projection. It is never a provider fact.
async function publishAccountChange({ operator, label, before, record, notifyAccountChange, now }) {
  if (typeof notifyAccountChange !== 'function' || !record || (record.invalidation?.state !== 'pending' && visibleIdentity(before, now) === visibleIdentity(record, now))) return record;
  try {
    await notifyAccountChange(record.account_id, setupAccessProjection(record, now));
    if (record.invalidation?.state !== 'pending') return record;
    const latest = await operator.workspaceRecord(label);
    if (identity(latest) !== identity(record)) return latest;
    return save(operator, label, latest, changed(latest, { invalidation: null }, now));
  } catch {
    const latest = await operator.workspaceRecord(label);
    if (identity(latest) !== identity(record)) return latest;
    return save(operator, label, latest, changed(latest, { invalidation: { state: 'pending', attempted_at: at(now) } }, now));
  }
}

async function queue({ operator, label, record, now }) {
  if (record.state !== 'prepared') return record;
  const queued = await save(operator, label, record, changed(record, { state: 'queued', reason: settings.words.queued }, now));
  try {
    const result = await operator.runTool('setup-access', {
      tool_id: settings.tool_id, input: { account_id: record.account_id, source_id: record.source_id, request_id: record.request_id },
      request_key: 'setup-access:' + record.request_id + ':' + record.attempt, wait_seconds: 0,
      job: 'Arrange the verified provider access required by this account setup',
    });
    if (result?.error) throw new Error('queue-refused');
    return queued;
  } catch {
    const latest = await operator.workspaceRecord(label);
    if (identity(latest) !== identity(queued)) return latest;
    return save(operator, label, queued, changed(queued, { state: 'blocked', blocker: 'tool-queue-unconfirmed', reason: 'The release-owner tool did not confirm the request. Retry will recheck provider state before any invitation.' }, now));
  }
}

/** Idempotent signup/setup hook. Context is the server's current account observation, never user body data. */
export async function prepareSetupAccess({ operator, userId, sourceId, context, mandate, consent = false, retry = false, enqueue = true, notifyAccountChange = null, now = Date.now() }) {
  if (!short(userId) || !operator) throw Object.assign(new Error('An authenticated account and release owner are required.'), { status: 401 });
  const label = setupAccessRecordLabel(userId, sourceId);
  let before = await operator.workspaceRecord(label);
  const original = before;
  const answer = async record => setupAccessProjection(await publishAccountChange({ operator, label, before: original, record, notifyAccountChange, now }), now);
  const observed = mandate ? { ...context, mandate } : context;
  const observer = currentObserver(observed);
  const observerHint = observer ? { ...observer, observed_at: at(now), expires_at: at(now + settings.observer_max_age_seconds * 1000) } : before?.observer_hint ?? null;
  // Only a server self-request context updates this hint. Foreign operator requests carry no user agent.
  if (before && observer && identity(before.observer_hint) !== identity(observerHint)) before = await save(operator, label, before, changed(before, { observer_hint: observerHint }, now));
  if (before?.lease && Date.parse(before.lease.expires_at) > now && observed?.setup_paused !== true) return answer(before);
  const contextIdentity = identity({ required: observed?.required === true, applicable: observed?.applicable === true, completed: observed?.completed === true,
    setup_paused: observed?.setup_paused === true, observer: currentObserver(observed) ?? keptObserver(before, now),
    mandate: observed?.mandate ?? null, requirement_identity: observed?.requirement_identity ?? null });
  const desired = await evaluate({ operator, userId, sourceId, context: observed, record: before, consent, now });
  if (['canceled', 'revoked'].includes(before?.state) && !consent) return answer(before);
  const sameRecipient = !desired.recipientIdentity || desired.recipientIdentity === before?.recipient_identity;
  const samePolicy = !desired.policy || desired.policy.version === before?.policy_version;
  // A native check may see a usable route before the shared public observation arrives. Its actual deadline
  // survives a screen reload, but only while the same current account requirement, recipient and policy permit it.
  if (before?.state === 'available' && !retry && desired.state === 'prepared' &&
      desired.recipientIdentity === before.recipient_identity && desired.policy.version === before.policy_version &&
      before.context_identity === contextIdentity && keptRoute(before, now)) return answer(before);
  if (before?.state === 'blocked' && !retry && !consent && desired.state === 'prepared' && sameRecipient && samePolicy && before.context_identity === contextIdentity) return answer(before);
  if (before && !retry && sameRecipient && samePolicy && desired.state === 'prepared' && ['queued', 'working', 'invited', 'accepted', 'installed', 'awaiting-invitation', 'indeterminate'].includes(before.state)) return answer(before);
  const renewed = consent && ['canceled', 'revoked'].includes(before?.state);
  const next = changed(before, { request_id: renewed ? crypto.randomUUID() : before?.request_id ?? crypto.randomUUID(), account_id: userId, source_id: sourceId,
    state: desired.state, reason: desired.reason, blocker: desired.blocker ?? null, action: desired.action ?? null, availability: desired.availability ?? null,
    recipient_identity: desired.recipientIdentity ?? before?.recipient_identity ?? null,
    mandate: desired.mandate ?? (sameRecipient ? before?.mandate ?? null : null), policy_version: desired.policy?.version ?? null,
    context_identity: contextIdentity,
    observer_hint: observerHint,
    attempt: (before?.attempt ?? 0) + (before && desired.state === 'prepared' && (retry || before.state !== 'prepared') ? 1 : 0), lease: null,
    ...(sameRecipient ? {} : { provider: null, mutations: {} }),
  }, now);
  if (before && identity({ ...next, changed_at: before.changed_at, history: before.history }) === identity(before)) return answer(enqueue ? await queue({ operator, label, record: before, now }) : before);
  const kept = await save(operator, label, before, next);
  return answer(enqueue ? await queue({ operator, label, record: kept, now }) : kept);
}

/** Shared authenticated handler. readAccountContext must resolve current setup facts and verified account identity.
 * GET returns status. POST prepare/retry/cancel is scoped to the caller. claim/checkpoint/finish is operator-only.
 * The native worker receives a recipient only from a successful claim; normal status never returns it. */
export async function manageSetupAccess(request, { userId, operatorId, operator, readAccountContext, notifyAccountChange = null, now = Date.now() }) {
  try {
    if (!userId || !operatorId || !operator || typeof readAccountContext !== 'function') return Response.json({ error: 'Authenticated setup access is unavailable.' }, { status: 401 });
    const url = new URL(request.url);
    let body = {};
    if (request.method !== 'GET') {
      const raw = await request.text();
      if (raw.length > settings.max_input_chars) return Response.json({ error: 'The request is too large.' }, { status: 413 });
      try { body = JSON.parse(raw || '{}'); } catch { return Response.json({ error: 'Send valid JSON.' }, { status: 400 }); }
    }
    if (!object(body)) return Response.json({ error: 'Send an object.' }, { status: 400 });
    const accountId = short(body.account_id ?? url.searchParams.get('account_id')) || userId;
    const sourceId = short(body.source_id ?? url.searchParams.get('source_id'));
    const operation = request.method === 'GET' ? 'read' : short(body.operation) || 'prepare';
    if (!['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Use GET or POST.' }, { status: 405 });
    const own = userId === accountId, isOperator = userId === operatorId;
    if ((!own && !isOperator) || (['claim', 'checkpoint', 'finish'].includes(operation) && !isOperator)) return Response.json({ error: 'This access request is not yours to perform.' }, { status: 403 });
    if (!distributionSource(sourceId)) return Response.json({ error: 'Name a configured source.' }, { status: 400 });
    const label = setupAccessRecordLabel(accountId, sourceId);
    const before = await operator.workspaceRecord(label);
    const publish = record => publishAccountChange({ operator, label, before, record, notifyAccountChange, now });
    const ownAnswer = projection => ({ ...projection, ...(own ? { refresh: true, said: projection.reason ?? null } : {}) });
    if (operation === 'read') return Response.json(setupAccessProjection(await publish(before), now));
    if (['prepare', 'retry'].includes(operation)) {
      const context = await readAccountContext(accountId, sourceId);
      return Response.json(ownAnswer(await prepareSetupAccess({ operator, userId: accountId, sourceId, context, consent: own && body.consent === true, retry: operation === 'retry', notifyAccountChange, now })));
    }
    if (!before || body.request_id !== before.request_id) return Response.json({ error: 'Read the current access request first.' }, { status: 409 });
    if (operation === 'cancel') {
      const next = changed(before, { state: 'canceled', mandate: { ...before.mandate, revoked: true }, lease: null, reason: settings.words.canceled }, now);
      return Response.json(ownAnswer(setupAccessProjection(await publish(await save(operator, label, before, next)), now)));
    }
    if (operation === 'claim') {
      if (terminal(before)) return Response.json({ authorized: false, ...setupAccessProjection(await publish(before), now) });
      if (before.lease && Date.parse(before.lease.expires_at) > now) return Response.json({ error: 'Another tool holds this request.', retry_at: before.lease.expires_at }, { status: 409 });
      const context = await readAccountContext(accountId, sourceId);
      const desired = await evaluate({ operator, userId: accountId, sourceId, context, record: before, now });
      if (desired.state !== 'prepared' || desired.recipientIdentity !== before.recipient_identity || desired.policy?.version !== before.policy_version) {
        const state = desired.state === 'prepared' ? 'blocked' : desired.state;
        const updated = await save(operator, label, before, changed(before, { state, reason: desired.state === 'prepared' ? 'The recipient or access policy changed. Renew this request.' : desired.reason, blocker: desired.blocker ?? 'request-changed', lease: null, action: desired.action ?? null, availability: desired.availability ?? null }, now));
        return Response.json({ authorized: false, ...setupAccessProjection(await publish(updated), now) });
      }
      const lease = { id: crypto.randomUUID(), expires_at: at(now + settings.lease_seconds * 1000) };
      const kept = await publish(await save(operator, label, before, changed(before, { state: 'working', lease, blocker: null }, now)));
      return Response.json({ authorized: true, request_id: kept.request_id, account_id: accountId, source_id: sourceId, lease,
        recipient: { email: desired.recipient, verified: true }, mandate: desired.mandate, policy: desired.policy,
        observer: desired.observer, provider: kept.provider ?? null, mutations: kept.mutations ?? {} });
    }
    if (!['checkpoint', 'finish'].includes(operation)) return Response.json({ error: 'Unknown setup access operation.' }, { status: 400 });
    if (!before.lease || body.lease_id !== before.lease.id || Date.parse(before.lease.expires_at) <= now || before.state === 'canceled') return Response.json({ error: 'This provider-action lease is no longer current.' }, { status: 409 });
    const context = await readAccountContext(accountId, sourceId);
    const desired = await evaluate({ operator, userId: accountId, sourceId, context, record: before, now });
    if (desired.blocker === 'setup-paused') {
      const paused = changed(before, { state: 'blocked', reason: desired.reason, blocker: desired.blocker,
        lease: null, action: null, availability: null }, now);
      return Response.json({ error: desired.reason, ...setupAccessProjection(await publish(await save(operator, label, before, paused)), now) }, { status: 403 });
    }
    if (operation === 'finish' && ['available', 'installed'].includes(desired.state)) {
      const next = changed(before, { state: desired.state, reason: desired.reason, action: desired.action ?? null, availability: desired.availability ?? null, lease: null }, now);
      return Response.json(setupAccessProjection(await publish(await save(operator, label, before, next)), now));
    }
    if (desired.state !== 'prepared' || desired.recipientIdentity !== before.recipient_identity || desired.policy?.version !== before.policy_version) return Response.json({ error: 'Current recipient, requirement or policy no longer permits this action.' }, { status: 403 });
    if (operation === 'checkpoint') {
      const mutation = short(body.mutation, 80);
      if (!['enroll', 'send-invitation'].includes(mutation)) return Response.json({ error: 'Name a supported provider mutation.' }, { status: 400 });
      const mutations = before.mutations ?? {};
      const previous = mutations[mutation];
      const scope = identity({ source_id: sourceId, provider: desired.policy.provider, recipient_identity: desired.recipientIdentity,
        ...(mutation === 'enroll' ? { group_name: desired.policy.group_name } : {}) });
      if (previous && previous.scope === scope && !(['refused', 'not-started'].includes(previous.state) && previous.attempt < before.attempt)) return Response.json({ allowed: false, reason: 'This provider mutation was already attempted; read its provider state before any further change.' });
      const next = changed(before, { mutations: { ...mutations, [mutation]: { at: at(now), attempt: before.attempt, state: 'attempted', scope } } }, now);
      await save(operator, label, before, next);
      return Response.json({ allowed: true });
    }
    const result = body.result;
    if (!object(result) || !settings.provider_states.includes(result.state)) return Response.json({ error: 'Name the observed provider result.' }, { status: 400 });
    const provider = { state: short(result.provider_state, 40) || null, tester_id: short(result.tester_id, 160) || null,
      group_id: short(result.group_id, 160) || null, app_id: short(result.app_id, 160) || null,
      checked_at: at(now), invitation_id: short(result.invitation_id, 160) || null };
    const mutations = { ...before.mutations };
    for (const name of ['enroll', 'send-invitation']) {
      const receipt = result.mutation_outcomes?.[name];
      if (mutations[name] && object(receipt) && ['observed', 'indeterminate', 'refused', 'not-started'].includes(receipt.state)) {
        const status = Number.isInteger(receipt.http_status) && receipt.http_status >= 400 && receipt.http_status < 500 && receipt.http_status !== 408 ? receipt.http_status : null;
        // Only a definite provider refusal reopens a reserved mutation on an explicit later retry.
        mutations[name] = { ...mutations[name], state: receipt.state === 'refused' && status === null ? 'indeterminate' : receipt.state, http_status: status };
      }
    }
    const bounds = availabilityBounds(result.availability, now);
    // A provider read cannot extend the target-device hint that made its public route eligible.
    const observerExpiry = Date.parse(before.observer_hint?.expires_at);
    const availability = bounds && Number.isFinite(observerExpiry) && Date.parse(bounds.expires_at) > observerExpiry
      ? { ...bounds, expires_at: at(observerExpiry) } : bounds;
    const route = result.state === 'available' ? usableRoute({ source_id: sourceId, usable_route: { ...result.action, ...availability, available: true, state: 'ready' } }, now) : null;
    if (result.state === 'available' && !route) return Response.json({ error: 'Available provider access needs its verified destination and a current bounded observation.' }, { status: 400 });
    const next = changed(before, { state: result.state, provider, mutations, lease: null, action: route?.action ?? null, availability: route?.availability ?? null,
      ...(result.state === 'revoked' ? { mandate: { ...before.mandate, revoked: true } } : {}),
      reason: short(result.reason, 600) || settings.words.unknown, blocker: short(result.blocker, 120) || null }, now);
    return Response.json(setupAccessProjection(await publish(await save(operator, label, before, next)), now));
  } catch (error) { return Response.json({ error: error.status ? error.message : settings.words.unknown }, { status: error.status ?? 503 }); }
}
