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
