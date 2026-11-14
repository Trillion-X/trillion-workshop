// Installation availability is an observation of a release owner, not a property of a URL.
// Definitions name sources and allowed destinations in devices.json. The operator's existing
// workspace records keep one current observation and bounded history per source. Consumers only
// read that operator-owned projection; account preferences never manufacture provider evidence.
import settings from './devices.json' with { type: 'json' };
import { workspaceValueIdentity } from 'trillion-workshop/tools/set-up-my-account/read-data/conflicts.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const config = () => settings.distribution;
export const distributionSource = id => config()?.sources?.find(source => source.id === id) ?? null;
export const distributionRecordLabel = id => `${config().record_prefix}${id}`;
const state = value => ['ready', 'blocked', 'unknown'].includes(value) ? value : 'unknown';

function destination(href, source) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password && source.allowed_hosts.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

const version = value => typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part))) ? value : null;
function compareVersion(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function eligibilityRequirements(value) {
  if (!object(value) || value.known !== true || !Array.isArray(value.alternatives) || !value.alternatives.length || value.alternatives.length > 30) return { known: false, alternatives: [] };
  const alternatives = value.alternatives.map(row => {
    if (!object(row) || (row.device_family != null && !/^[A-Z_]{1,40}$/.test(row.device_family)) || (row.minimum_os != null && !version(row.minimum_os)) || (row.maximum_os != null && !version(row.maximum_os))) throw new Error('Provider eligibility requirements were not understood.');
    return { device_family: row.device_family ?? null, minimum_os: row.minimum_os ?? null, maximum_os: row.maximum_os ?? null };
  });
  return { known: true, scope: 'minimum_os_and_public_recruitment', alternatives };
}

/** A server-observed device may resolve public recruitment requirements; account preferences cannot. */
export function routeEligibility(source, route, observer = null) {
  const requirements = route.eligibility_requirements;
  if (!requirements?.known) return route.eligibility_state === 'blocked' ? 'blocked' : 'unknown';
  const family = observer?.device_family;
  const os = version(observer?.os_version);
  if (!family || !source.product_families?.includes(family)) return 'unknown';
  let unknown = false;
  for (const alternative of requirements.alternatives) {
    if (alternative.device_family && alternative.device_family !== family) continue;
    if ((alternative.minimum_os || alternative.maximum_os) && !os) { unknown = true; continue; }
    if (alternative.minimum_os && compareVersion(os, alternative.minimum_os) < 0) continue;
    if (alternative.maximum_os && compareVersion(os, alternative.maximum_os) > 0) continue;
    return 'ready';
  }
  return unknown ? 'unknown' : 'blocked';
}

/** Only the safe public projection is kept; private tester details and arbitrary provider payloads never escape. */
export function distributionObservation(source, value, now = Date.now()) {
  if (!source || !object(value)) throw new Error('Name a configured distribution source and its observed result.');
  const checked = Date.parse(value.checked_at);
  const expires = Date.parse(value.expires_at);
  if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now + config().clock_skew_seconds * 1000 || expires <= checked || expires > checked + config().max_age_seconds * 1000) {
    throw new Error('An observation needs its actual check time and a bounded expiry.');
  }
  if (!Array.isArray(value.routes) || value.routes.length > config().max_routes) throw new Error('The observed installation routes must be a bounded list.');
  const ids = new Set();
  const routes = value.routes.map(route => {
    if (!object(route) || !text(route.id) || route.id.length > 160 || ids.has(route.id)) throw new Error('Every installation route needs a distinct short identity.');
    ids.add(route.id);
    if (source.channels && !source.channels.includes(route.channel)) throw new Error('This shared observation cannot contain a private or unconfigured route.');
    const href = destination(route.action?.href ?? route.href ?? route.evidence?.public_link ?? route.check?.href, source);
    if (route.state === 'ready' && !href) throw new Error('An available route needs an allowed, usable destination.');
    const expiry = Date.parse(route.expires_at ?? value.expires_at);
    if (!Number.isFinite(expiry) || expiry > expires) throw new Error('A route cannot outlive its observation.');
    return {
      id: route.id, state: state(route.state),
      distribution_state: state(route.distribution_state ?? route.state),
      eligibility_state: state(route.eligibility_state ?? route.state),
      reason: text(route.reason).slice(0, 600),
      ...(text(route.channel) ? { channel: route.channel.slice(0, 60) } : {}),
      ...(href ? { check: { href }, ...(route.state === 'ready' ? { action: { href, ...(text(route.action?.label) ? { label: route.action.label.slice(0, 100) } : {}) } } : {}) } : {}),
      ...(text(route.build_id) ? { build_id: route.build_id.slice(0, 160) } : {}),
      ...(text(route.group_id) ? { group_id: route.group_id.slice(0, 160) } : {}),
      expires_at: new Date(expiry).toISOString(),
      eligibility_requirements: eligibilityRequirements(route.eligibility_requirements),
    };
  });
  return { source_id: source.id, checked_at: new Date(checked).toISOString(), expires_at: new Date(expires).toISOString(), routes };
}

/** All requested sources are read once from the trusted owner. Failed and absent reads stay unknown. */
export async function readDeviceDistribution(operator, now = Date.now(), { refresh = false, waitUntil = null } = {}) {
  const entries = await Promise.all((config()?.sources ?? []).map(async source => {
    try {
      const record = await operator?.workspaceRecord(distributionRecordLabel(source.id));
      const value = distributionObservation(source, record?.current, now);
      if (refresh && Date.parse(value.expires_at) <= now) refreshDistribution(operator, source, now, waitUntil);
      return [source.id, value];
    } catch {
      if (refresh) refreshDistribution(operator, source, now, waitUntil);
      return [source.id, null];
    }
  }));
  return Object.fromEntries(entries);
}

// On-demand refresh belongs to the release owner. The Workshop owns retries, capacity, holds
// and duplicate suppression; no customer page starts an Apple request or a private AI loop.
function refreshDistribution(operator, source, now, waitUntil) {
  if (!operator || !source.refresh_tool || typeof waitUntil !== 'function') return;
  const window = Math.floor(now / (config().max_age_seconds * 1000));
  // The release owner's store runs the refresh with its own connection; the readers of every account ask the record's
  // own refresh owner first (src/service-records.mjs want), so only the first read of each window reaches that store.
  const work = Promise.resolve().then(async () => {
    if (operator.want && !(await operator.want(distributionRecordLabel(source.id), window))) return null;
    return operator.runTool('device-distribution', {
      tool_id: source.refresh_tool, input: { source_id: source.id, publish: true },
      request_key: `distribution:${source.id}:${window}`,
      wait_seconds: 0, job: 'Verify the installation access a person needs to finish setup',
    });
  }).catch(() => null);
  try { waitUntil(work); } catch { /* A failed background registration never becomes a customer fact. */ }
}

/** Resolve DATA routes only; a configured address is never proof of a verified channel's readiness. */
export function observedInstallWays(entry, distribution, now = Date.now(), observer = null) {
  if (!entry.distribution_source) return [{ ...entry, available: Boolean(entry.href), state: entry.href ? 'ready' : 'blocked' }];
  const source = distributionSource(entry.distribution_source);
  const observation = distribution?.[entry.distribution_source];
  const unknown = { ...entry, href: null, available: null, state: 'unknown', not_yet: entry.not_yet ?? config().words.unknown,
    ...(source && destination(entry.href, source) ? { recovery: { label: source.check_label ?? config().words.check_access, href: entry.href } } : {}),
    prerequisite: { owner: source?.owner ?? 'release-owner', source_id: entry.distribution_source, state: 'unknown', next_action: source?.refresh_tool ?? null } };
  let safe;
  try { safe = distributionObservation(source, observation, now); } catch { return [unknown]; }
  if (Date.parse(safe.expires_at) <= now) return [{ ...unknown, not_yet: config().words.stale }];
  const routes = safe.routes.filter(route => !entry.channels || entry.channels.includes(route.channel));
  if (!routes.length) return [{ ...unknown, not_yet: config().words.no_route }];
  return routes.map(route => {
    // A public channel can be live while this person's eligibility remains unproved.
    const fresh = Date.parse(route.expires_at) > now;
    const eligibility = routeEligibility(source, route, observer);
    const ready = fresh && route.distribution_state === 'ready' && eligibility === 'ready' && Boolean(route.check?.href);
    const blocked = fresh && (route.distribution_state === 'blocked' || eligibility === 'blocked');
    const reason = !fresh ? config().words.stale : eligibility === 'blocked' ? config().words.ineligible : route.reason;
    return {
      systems: entry.systems, label: route.action?.label ?? source.labels?.[route.channel] ?? entry.label,
      href: ready ? route.check.href : null,
      available: ready ? true : blocked ? false : null,
      state: ready ? 'ready' : blocked ? 'blocked' : 'unknown',
      ...(!ready ? { not_yet: reason || entry.not_yet || config().words.waiting, reason,
        ...(!blocked && route.check?.href ? { recovery: { label: source.check_label ?? config().words.check_access, href: route.check.href } } : {}) } : {}),
      source_id: source.id, route_id: route.id, checked_at: safe.checked_at, expires_at: route.expires_at,
      prerequisite: { owner: source.owner, source_id: source.id, state: ready ? 'ready' : blocked ? 'blocked' : 'unknown', reason, next_action: source.refresh_tool ?? null },
    };
  });
}

/** Same management operation for the signed-in screen and the authenticated agent endpoint. */
export async function manageDeviceDistribution(request, { operator, userId, operatorId, now = Date.now() }) {
  if (!operatorId || userId !== operatorId) return Response.json({ error: 'Only the release owner can manage shared installation availability.' }, { status: 403 });
  const url = new URL(request.url);
  let body = {};
  if (request.method !== 'GET') {
    const raw = await request.text();
    if (raw.length > config().max_input_chars) return Response.json({ error: 'The observation is too large.' }, { status: 413 });
    try { body = JSON.parse(raw || '{}'); } catch { return Response.json({ error: 'Send valid JSON.' }, { status: 400 }); }
  }
  if (!object(body)) return Response.json({ error: 'Send an object.' }, { status: 400 });
  const source = distributionSource(body.source_id ?? url.searchParams.get('source_id'));
  if (!source) return Response.json({ error: 'Name one configured distribution source.' }, { status: 400 });
  const label = distributionRecordLabel(source.id);
  const current = await operator.workspaceRecord(label);
  const currentIdentity = current == null ? null : workspaceValueIdentity(current);
  if (request.method === 'GET') return Response.json({ source_id: source.id, record: current, identity: currentIdentity });
  if (!['PUT', 'DELETE'].includes(request.method)) return Response.json({ error: 'Use GET, PUT or DELETE.' }, { status: 405 });
  if (!Object.hasOwn(body, 'expected_identity') || body.expected_identity !== currentIdentity) return Response.json({ error: 'Read this source again before changing it.', identity: currentIdentity }, { status: 409 });
  let observation = null;
  try { if (request.method === 'PUT') observation = distributionObservation(source, body.observation, now); }
  catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  if (observation && current?.current && Date.parse(observation.checked_at) < Date.parse(current.current.checked_at)) return Response.json({ error: 'An older observation cannot replace a newer result.' }, { status: 409 });
  if (JSON.stringify(current?.current ?? null) === JSON.stringify(observation)) return Response.json({ saved: false, unchanged: true, identity: currentIdentity });
  const next = { current: observation, changed_at: new Date(now).toISOString(), changed_by: userId,
    history: [...(Array.isArray(current?.history) ? current.history : []), ...(current?.current ? [current.current] : [])].slice(-config().history_limit) };
  const result = await operator.putWorkspaceRecords([{ address_label: label, payload: next, expected_identity: currentIdentity }]);
  if (result?.ok === false || result?.refused || result?.conflicts?.length) return Response.json({ error: 'This source changed during the save. Read it again.', result }, { status: 409 });
  const after = await operator.workspaceRecord(label);
  if (JSON.stringify(after) !== JSON.stringify(next)) return Response.json({ error: 'The saved observation could not be confirmed. Read the source again.' }, { status: 409 });
  return Response.json({ saved: true, source_id: source.id, identity: workspaceValueIdentity(after), record: after });
}
