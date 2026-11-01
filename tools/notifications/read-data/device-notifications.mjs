// Device registration, durable notice dispatch and Live Activity delivery for tools/notifications.
// All private addresses and provider material stay in the person's scoped records/private credential pipe.
import { readFileSync } from 'node:fs';
import DELIVERY from './delivery-contract.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { base64url as browserBase64url, applicationServerKey, checkedSubscription, sendPush } from './web-push.mjs';
import { requestHttp2 } from './http2-request.mjs';

export const DEVICE = 'notification-device';
export const ACTIVITY = 'notification-live-activity';
export const ACTIVITY_START = 'notification-live-activity-start';
export const ACTIVITY_DELIVERY = 'notification-live-activity-delivery';
export const TOLD = 'told-the-person';
const DEVICE_PREFIX = `${DEVICE}:`;
const ACTIVITY_PREFIX = `${ACTIVITY}:`;
const TOLD_HEAD = TOLD;
const TOLD_PREFIX = `${TOLD}:`;
const TOLD_KEEP = 200;
const TOLD_KEEP_EACH_KIND = 10;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isoNow = now => now().toISOString();
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const idFor = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).replace(':', '');
const word = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${name} must be 1 to ${max} characters.`);
  return value.trim();
};
const activityAttributesType = value => {
  const type = word(value, 200, 'attributes_type');
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(type)) {
    throw new Error('attributes_type must be a Swift type name, optionally qualified by its module.');
  }
  return type;
};
const localPath = (value, name) => {
  if (typeof value !== 'string' || !/^\/(?![/\\])[^\\]*$/.test(value)) throw new Error(`${name} must be a local app path beginning with one slash.`);
  return value;
};
const deviceId = (route, address) => `${DEVICE_PREFIX}${idFor(`${route}\0${JSON.stringify(address)}`)}`;
const activityId = (key, token) => `${ACTIVITY_PREFIX}${idFor(`${key}\0${token.toLowerCase()}`)}`;
const ROUTES = Object.freeze({
  'web-push': { shape: 'web-push-subscription', label: 'A browser' },
  apns: { shape: 'hex-token', label: 'An iPhone' },
  'apns-activity': { shape: 'hex-token', label: "An iPhone's Live Activity" },
  live: { shape: 'device-id', label: 'A Mac' },
});
const CAN_SHOW = new Set(['allowed', 'denied', 'not-asked', 'quiet']);
const PRESENT = new Set(['here', 'away']);
const TURN_ON_SCHEMES = new Set(['https', 'x-apple.systempreferences', 'app-settings', 'ms-settings']);

async function all(door, type, prefix) {
  const result = [];
  for await (const row of door.list({ type, prefix })) result.push(row);
  return result;
}

function publicDevice(row) {
  const { device_id, route, label, app, environment, can_show, turn_on, present, present_at, added_at } = row.value;
  return { device_id, route, label, ...(app ? { app } : {}), ...(environment ? { environment } : {}), ...(can_show ? { can_show } : {}), ...(turn_on ? { turn_on } : {}), ...(present ? { present, present_at } : {}), added_at };
}

function checkedAddress(route, address) {
  if (!ROUTES[route]) throw new Error(`There is no notification device route ${route}. Choose web-push, apns, apns-activity or live.`);
  if (ROUTES[route].shape === 'web-push-subscription') {
    const checked = checkedSubscription(address);
    return {
      endpoint: checked.endpoint.href,
      keys: { p256dh: browserBase64url(checked.keys.p256dh), auth: browserBase64url(checked.keys.auth) },
    };
  }
  if (ROUTES[route].shape === 'hex-token') {
    if (typeof address !== 'string' || !/^[0-9a-f]{32,400}$/i.test(address.trim())) throw new Error('This device address must be the hex token its system gave it.');
    return address.trim().toLowerCase();
  }
  if (typeof address !== 'string' || !/^[A-Za-z0-9._-]{8,80}$/.test(address.trim())) throw new Error('This device address must be its stable device id (8 to 80 letters, digits, dots, underscores or hyphens).');
  return address.trim();
}

const addressIdentity = (route, address) => route === 'web-push'
  ? address.endpoint
  : JSON.stringify(address);

export async function listMyNotificationDevices(_input, { door }) {
  const devices = (await all(door, DEVICE, DEVICE_PREFIX)).map(publicDevice).sort((a, b) => a.added_at.localeCompare(b.added_at));
  return { devices, said: `${devices.length} ${devices.length === 1 ? 'device is' : 'devices are'} registered.` };
}

/** Repeating the same route/address preserves its id and original added_at; address never leaves this function. */
export async function registerMyNotificationDevice(input, { door, now = () => new Date() }) {
  const route = word(input?.route, 80, 'route');
  const address = checkedAddress(route, input?.address);
  const id = deviceId(route, addressIdentity(route, address));
  const app = text(input.app);
  if (['apns', 'apns-activity'].includes(route) && !app) throw new Error('An Apple device registration needs the app bundle id for its APNs topic.');
  const attributes_type = route === 'apns-activity' ? activityAttributesType(input.attributes_type) : null;
  if (input.environment !== undefined && !['sandbox', 'production'].includes(input.environment)) throw new Error('environment must be sandbox or production.');
  const prior = await door.readRecord(DEVICE, id);
  const canShow = input.can_show == null ? null : word(input.can_show, 40, 'can_show');
  if (canShow && !CAN_SHOW.has(canShow)) throw new Error(`can_show must be one of ${[...CAN_SHOW].join(', ')}.`);
  const present = input.present == null ? null : word(input.present, 40, 'present');
  if (present && !PRESENT.has(present)) throw new Error(`present must be one of ${[...PRESENT].join(', ')}.`);
  let turnOn = null;
  if (input.turn_on != null) {
    const given = word(input.turn_on, 400, 'turn_on');
    let url;
    try { url = new URL(given); } catch { throw new Error('turn_on must be a valid link to this device’s notification settings.'); }
    if (!TURN_ON_SCHEMES.has(url.protocol.slice(0, -1))) throw new Error('turn_on must use https, x-apple.systempreferences, app-settings or ms-settings.');
    turnOn = given;
  }
  const before = object(prior?.value) ? prior.value : null;
  const value = {
    device_id: id.slice(DEVICE_PREFIX.length), route, address,
    label: text(input.label).slice(0, 120) || ROUTES[route].label,
    ...(app ? { app: app.slice(0, 200) } : {}),
    ...(attributes_type ? { attributes_type } : {}),
    ...(input.environment === 'sandbox' || input.environment === 'production' ? { environment: input.environment } : {}),
    ...(canShow ? { can_show: canShow } : before?.can_show ? { can_show: before.can_show } : {}),
    ...(turnOn ? { turn_on: turnOn } : before?.turn_on ? { turn_on: before.turn_on } : {}),
    ...(present ? { present, present_at: isoNow(now) } : before?.present ? { present: before.present, present_at: before.present_at } : {}),
    added_at: before?.added_at ?? isoNow(now),
  };
  if (before && same(before, value)) {
    const devices = (await all(door, DEVICE, DEVICE_PREFIX)).map(publicDevice);
    return { device_id: value.device_id, changed: false, devices, said: 'This device was already registered with these details.' };
  }
  const records = await all(door, DEVICE, DEVICE_PREFIX);
  const byId = new Map(records.map(row => [row.id, row]));
  byId.set(id, { id, type: DEVICE, value });
  const ordered = [...byId.values()].sort((a, b) => String(a.value.added_at).localeCompare(String(b.value.added_at)));
  const expired = ordered.slice(0, Math.max(0, ordered.length - 40)).filter(row => row.id !== id);
  const writes = [{ id, type: DEVICE, value, expected: prior ? { type: DEVICE, value: prior.value } : null },
    ...expired.map(row => ({ id: row.id, type: DEVICE, value: null, expected: { type: DEVICE, value: row.value } }))];
  await door.write(writes, { key: `register-notification-device:${id}:${idFor(JSON.stringify(sorted(value)))}` });
  const devices = (await all(door, DEVICE, DEVICE_PREFIX)).map(publicDevice).sort((a, b) => a.added_at.localeCompare(b.added_at));
  return { device_id: value.device_id, changed: true, devices, said: 'This device is registered for notices.' };
}

export async function removeMyNotificationDevice(input, { door }) {
  const device_id = word(input?.device_id, 80, 'device_id');
  const id = `${DEVICE_PREFIX}${device_id}`;
  const prior = await door.readRecord(DEVICE, id);
  if (!prior || !object(prior.value)) return { device_id, removed: false, said: 'That device was not registered.' };
  await door.write([{ id, type: DEVICE, value: null, expected: { type: DEVICE, value: prior.value } }], { key: `remove-notification-device:${id}:${idFor(JSON.stringify(sorted(prior.value)))}` });
  return { device_id, removed: true, said: 'The device was removed.' };
}

export async function registerMyLiveActivity(input, { door, now = () => new Date() }) {
  const board_key = word(input?.board_key, 200, 'board_key');
  const token = word(input?.token, 400, 'token').toLowerCase();
  if (!/^[0-9a-f]{32,400}$/.test(token)) throw new Error('A Live Activity token must be the hex token its system gave it.');
  const app = word(input?.app, 200, 'app');
  if (input.environment !== undefined && !['sandbox', 'production'].includes(input.environment)) throw new Error('environment must be sandbox or production.');
  const environment = input.environment ?? 'production';
  const id = activityId(board_key, token);
  const prior = await door.readRecord(ACTIVITY, id);
  if (input.ended === true) {
    if (prior) await door.write([{ id, type: ACTIVITY, value: null, expected: { type: ACTIVITY, value: prior.value } }], { key: `end-live-activity:${id}` });
    return { board_key, kept: false, ended: true, said: 'The Live Activity token was removed.' };
  }
  const value = { board_key, token, app, environment, kept_at: prior?.value?.kept_at ?? now().toISOString() };
  if (prior && same(prior.value, value)) return { board_key, kept: true, ended: false, changed: false, said: 'This Live Activity was already registered.' };
  await door.write([{ id, type: ACTIVITY, value, expected: prior ? { type: ACTIVITY, value: prior.value } : null }], { key: `register-live-activity:${id}:${idFor(JSON.stringify(sorted(value)))}` });
  return { board_key, kept: true, ended: false, changed: true, said: 'The Live Activity is registered.' };
}

function currentEventShape(event) {
  return {
    seq: event.seq, key: event.key, kind: event.kind, title: event.title, body: event.body,
    open: event.open ?? null, at: event.at, refs: event.refs ?? {}, results: event.results ?? {}, read: Boolean(event.read),
    ...(event.read_on ? { read_on: event.read_on } : {}),
  };
}

async function noticeRows(door) {
  const rows = await all(door, TOLD);
  const byId = new Map(rows.map(row => [row.id, row]));
  const head = byId.get(TOLD_HEAD)?.value ?? {};
  const items = Array.isArray(head.items) ? head.items : (head.seqs ?? []).map(seq => byId.get(`${TOLD}:${seq}`)?.value?.item).filter(Boolean);
  return { rows, byId, head, items };
}

async function reserveNotice(door, event, audience, attempt, now = () => new Date()) {
  const { byId, head, items } = await noticeRows(door);
  const earlier = items.find(item => item.key === event.notification_id);
  if (earlier) return { item: earlier, prior: true, id: `${TOLD}:${earlier.seq}` };
  const seq = Math.max(0, ...items.map(item => Number(item.seq) || 0)) + 1;
  const id = `${TOLD}:${seq}`;
  const at = event.occurred_at;
  const devices = (await all(door, DEVICE, DEVICE_PREFIX)).map(row => row.value).filter(row => object(row) && row.can_show !== 'denied' && row.can_show !== 'quiet');
  const push = devices.filter(row => row.route === 'apns');
  const browsers = devices.filter(row => row.route === 'web-push');
  const pull = devices.filter(row => row.route === 'live');
  const results = {
    'device-pull': pull.length ? { sent: true, stage: 'queued', device_ids: pull.map(device => device.device_id).filter(Boolean), said: `Kept for ${pull.length} ${pull.length === 1 ? 'device' : 'devices'} to show on its next read.` }
      : { sent: false, stage: 'unavailable', said: 'No device is registered to read notices.' },
    apns: push.length ? { sent: false, stage: 'attempting', attempt, started_at: isoNow(now), said: 'Apple’s response is not known yet.' }
      : { sent: false, stage: 'unavailable', said: 'No iPhone is registered to show push notices.' },
    'web-push': browsers.length ? { sent: false, stage: 'attempting', attempt, started_at: isoNow(now), said: 'The browser push service’s response is not known yet.' }
      : { sent: false, stage: 'unavailable', said: 'No browser is registered to show push notices.' },
  };
  const item = {
    seq, key: event.notification_id, kind: event.kind, title: event.title, body: event.body, open: event.open ?? null,
    actions: Array.isArray(event.actions) ? event.actions : [],
    at, refs: { audience, conversation: event.conversation_ref, source: event.source_refs, proof: event.proof_refs },
    results, read: false,
  };
  const newestByKind = new Map();
  const retained = [];
  const allItems = [...items, item].sort((a, b) => a.seq - b.seq);
  for (const notice of [...allItems].reverse()) {
    const count = newestByKind.get(notice.kind) ?? 0;
    if (retained.length < TOLD_KEEP || count < TOLD_KEEP_EACH_KIND) {
      retained.push(notice);
      newestByKind.set(notice.kind, count + 1);
    }
  }
  retained.reverse();
  const keepSeqs = new Set(retained.map(notice => notice.seq));
  const headValue = Array.isArray(head.items)
    ? { seqs: retained.map(notice => notice.seq) }
    : { ...head, seqs: retained.map(notice => notice.seq) };
  const oldHead = byId.get(TOLD_HEAD);
  const writes = [
    { id: TOLD_HEAD, type: TOLD, value: headValue, expected: oldHead ? { type: TOLD, value: oldHead.value } : null },
    { id, type: TOLD, value: { item }, expected: null },
  ];
  if (Array.isArray(head.items)) for (const priorItem of retained) {
    if (priorItem.seq === seq) continue;
    const priorId = `${TOLD}:${priorItem.seq}`;
    if (!byId.has(priorId)) writes.push({ id: priorId, type: TOLD, value: { item: priorItem }, expected: null });
  }
  for (const row of byId.values()) {
    const match = row.id.match(/^told-the-person:(\d+)$/);
    if (match && !keepSeqs.has(Number(match[1]))) writes.push({ id: row.id, type: TOLD, value: null, expected: { type: TOLD, value: row.value } });
  }
  await door.write(writes, { key: `reserve-notification:${event.notification_id}` });
  const settled = await door.readRecord(TOLD, id);
  const hasThisAttempt = ['apns', 'web-push'].some(route => settled?.value?.item?.results?.[route]?.attempt === attempt);
  if (!hasThisAttempt) return { item: settled?.value?.item ?? item, prior: true, id };
  return { item, prior: false, id, push, browsers, attempt };
}

function apnsKey(credentials) {
  let key = credentials;
  if (typeof credentials === 'string') {
    try { key = credentials ? JSON.parse(credentials) : null; }
    catch { throw new Error('The Apple signing key is not valid JSON.'); }
  }
  if (!object(key) || !text(key.key_id) || !text(key.team_id) || !text(key.pem)) throw new Error('No complete Apple push key was handed to this run. Supply key_id, team_id and pem fields in the notification-signing-keys bundle.');
  return { key_id: key.key_id, team_id: key.team_id, pem: key.pem };
}

function webPushKey(credentials) {
  let key = credentials;
  if (typeof credentials === 'string') {
    try { key = credentials ? JSON.parse(credentials) : null; }
    catch { throw new Error('The browser signing key is not valid JSON.'); }
  }
  if (!object(key) || !object(key.jwk) || !text(key.contact)) throw new Error('No complete browser push key was handed to this run. Supply web_push.jwk and web_push.contact in the notification-signing-keys bundle.');
  return { jwk: key.jwk, contact: key.contact };
}

function readSigningKeys(fd = 4, read = descriptor => readFileSync(descriptor, 'utf8')) {
  let raw;
  try { raw = read(fd); } catch { raw = ''; }
  if (!raw) return {};
  let bundle;
  try { bundle = JSON.parse(raw); } catch { throw new Error('The notification-signing-keys bundle is not valid JSON.'); }
  if (!object(bundle)) throw new Error('The notification-signing-keys bundle must be a JSON object.');
  return { apns: bundle.apns, web_push: bundle.web_push };
}

/** Returns only the VAPID public point needed by a browser subscription; the private scalar stays on the credential pipe. */
export async function myBrowserPushApplicationServerKey(_input, { webCredentials = '' } = {}) {
  const key = webPushKey(webCredentials);
  try {
    return { applicationServerKey: await applicationServerKey(key), said: 'The browser push key is ready for device registration.' };
  } catch { throw new Error('The browser signing key is not a valid private P-256 key.'); }
}

const base64url = bytes => Buffer.from(bytes).toString('base64url');
const json64 = value => base64url(Buffer.from(JSON.stringify(value)));
async function signingKey(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) throw new Error('The held Apple push key has no PKCS#8 key text. Reconnect the Apple push key.');
  return crypto.subtle.importKey('pkcs8', Buffer.from(body, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
async function providerToken(key, nowMs) {
  const seconds = Math.floor(nowMs / 1000);
  const body = `${json64({ alg: 'ES256', kid: key.key_id })}.${json64({ iss: key.team_id, iat: seconds })}`;
  try {
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(key.pem), Buffer.from(body));
    return `${body}.${base64url(signature)}`;
  } catch { throw new Error('The Apple signing key could not sign this request.'); }
}

export function apnsPusher({ key, send = requestHttp2, now = () => Date.now(), tokenMinutes = 40 } = {}) {
  const heldKey = apnsKey(key);
  let heldToken = null;
  return async function push({ token, topic, environment = 'production', push_type = 'alert', priority = 10, payload, collapse_id = null, expiration = null }) {
    const host = environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    if (!heldToken || now() - heldToken.at > tokenMinutes * 60_000) heldToken = { at: now(), value: await providerToken(heldKey, now()) };
    const response = await send(`${host}/3/device/${token}`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `bearer ${heldToken.value}`, 'apns-topic': topic, 'apns-push-type': push_type,
        'apns-priority': String(priority), ...(collapse_id ? { 'apns-collapse-id': String(collapse_id).slice(0, 64) } : {}),
        ...(expiration !== null ? { 'apns-expiration': String(expiration) } : {}), 'content-type': 'application/json',
      }, body: JSON.stringify(payload),
    });
    if (response.ok) return { sent: true, status: response.status };
    const reason = await response.json().then(answer => answer.reason).catch(() => null);
    return { sent: false, status: response.status, gone: response.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason), error: `Apple answered ${response.status}.` };
  };
}

async function writeItem(door, id, before, item, key) {
  const value = { item };
  await door.write([{ id, type: TOLD, value, expected: { type: TOLD, value: { item: before } } }], { key });
}

/** Records before sending. Unknown network outcomes are held and never retried blindly on either push route. */
export async function sendNotificationToMyDevices(input, { door, credentials = '', webCredentials = '', send, now = () => Date.now() } = {}) {
  const notification_id = word(input?.notification_id, 200, 'notification_id');
  const audience = word(input?.audience, 200, 'audience');
  const eventRecord = await door.readRecord('notification-event', `notification-event:${notification_id}`);
  const event = eventRecord?.value;
  if (!object(event)) return { notification_id, recorded: false, delivered: false, stage: 'unavailable', said: `There is no recorded notification ${notification_id}. Record it first.` };
  if (!Array.isArray(event.audience_refs) || !event.audience_refs.includes(audience)) throw new Error(`The notification ${notification_id} does not name ${audience} in audience_refs.`);
  const firstAttempt = crypto.randomUUID();
  const reserved = await reserveNotice(door, event, audience, firstAttempt, () => new Date(now()));
  const { id } = reserved;
  let item = reserved.item;
  if (item.read === true) return { notification_id, recorded: true, delivered: false, stage: 'read', said: 'This notification has already been read; no push was retried.' };
  const devices = await all(door, DEVICE, DEVICE_PREFIX);
  const routes = [
    { route: 'apns', devices: reserved.push ?? devices.map(row => row.value).filter(device => device.route === 'apns' && device.can_show !== 'denied' && device.can_show !== 'quiet'), unknownSaid: 'Apple’s delivery outcome is unknown; it was not sent again.' },
    { route: 'web-push', devices: reserved.browsers ?? devices.map(row => row.value).filter(device => device.route === 'web-push' && device.can_show !== 'denied' && device.can_show !== 'quiet'), unknownSaid: 'The browser push outcome is unknown; it was not sent again.' },
  ];
  const active = [];
  const retryAttempt = crypto.randomUUID();
  let claimed = item;
  for (const candidate of routes) {
    const previous = item.results?.[candidate.route] ?? {};
    if (previous.stage === 'attempting' && previous.attempt === reserved.attempt && !reserved.prior) {
      active.push({ ...candidate, attempt: reserved.attempt, device_results: previous.device_results ?? [] });
      continue;
    }
    if (!reserved.prior) continue;
    if (previous.stage === 'uncertain' || previous.stage === 'attempting') continue;
    const failedDeviceIds = new Set((previous.device_results ?? []).filter(result => result.stage === 'not-sent').map(result => result.device_id));
    const retryPartial = previous.sent === true && failedDeviceIds.size > 0 && input.retry_failed === true;
    const retryWholeRoute = previous.sent !== true && ['not-sent', 'unavailable'].includes(previous.stage) && input.retry_failed === true;
    if (!retryPartial && !retryWholeRoute) continue;
    const attempt = `${retryAttempt}:${candidate.route}`;
    const device_results = previous.device_results ?? [];
    const devices = retryPartial ? candidate.devices.filter(device => failedDeviceIds.has(device.device_id)) : candidate.devices;
    claimed = { ...claimed, results: { ...claimed.results, [candidate.route]: { ...previous, sent: Boolean(previous.sent), stage: 'attempting', attempt, started_at: new Date(now()).toISOString(), said: 'The provider’s response is not known yet.' } } };
    active.push({ ...candidate, devices, attempt, device_results });
  }
  if (claimed !== item) {
    await writeItem(door, id, item, claimed, `retry-notification:${notification_id}:${retryAttempt}`);
    item = claimed;
  }
  if (!active.length) {
    const outcomes = ['apns', 'web-push'].map(route => item.results?.[route] ?? {}).filter(result => result.stage !== 'unavailable');
    const accepted = outcomes.some(result => result.sent === true || result.stage === 'sent');
    const uncertain = outcomes.some(result => ['attempting', 'uncertain'].includes(result.stage));
    return { notification_id, recorded: true, delivered: accepted, stage: accepted ? 'sent' : uncertain ? 'uncertain' : 'not-sent', said: accepted ? 'A push provider already accepted this notice; whether anyone read it is unknown.' : uncertain ? 'A push provider outcome is unknown; it was not sent again.' : 'This notice has no retryable push delivery.' };
  }
  let apnsPush;
  let vapid;
  try { if (active.some(route => route.route === 'apns')) apnsPush = apnsPusher({ key: credentials, send, now }); }
  catch { /* Settle the route as unavailable below; never copy credential errors into the person's records. */ }
  try { if (active.some(route => route.route === 'web-push')) vapid = webPushKey(webCredentials); }
  catch { /* Settle the route as unavailable below; never copy credential errors into the person's records. */ }
  const settleRoute = async (route, value, key) => {
    const updated = { ...item, results: { ...item.results, [route]: value } };
    await writeItem(door, id, item, updated, key);
    item = updated;
  };
  for (const route of active) {
    if (route.route === 'apns' && !apnsPush || route.route === 'web-push' && !vapid) {
      const provider = route.route === 'apns' ? 'Apple' : 'browser';
      const missing = { sent: false, stage: 'unavailable', said: `The ${provider} push key is not available to this run.` };
      await settleRoute(route.route, missing, `notification-key-unavailable:${notification_id}:${route.attempt}`);
      continue;
    }
    const sent = [];
    for (const device of route.devices) {
      try {
        const payloadKey = DELIVERY.apns_payload_key;
        const deviceActions = (event.actions ?? []).map(action => ({
          id: action.id, label: action.label,
          ...(object(action.input) ? { input: action.input } : {}),
          ...(action.opens === true || action.press === true ? { opens: true } : {}),
          ...(action.destructive === true ? { destructive: true } : {}),
        }));
        const category = deviceActions.length
          ? [DELIVERY.apns_category_prefix, ...deviceActions.map(action => action.id)].join('.')
          : undefined;
        const notice = { id: `told:${item.seq}`, notification_id, kind: event.kind, open: event.open ?? null, actions: deviceActions };
        const result = route.route === 'apns'
          ? await apnsPush({ token: device.address, topic: word(device.app, 200, 'registered app'), environment: device.environment,
            payload: { aps: { alert: { title: event.title, body: event.body }, sound: 'default', 'interruption-level': 'active', 'mutable-content': 1,
              'thread-id': event.conversation_ref || event.kind, ...(category ? { category } : {}) }, [payloadKey]: notice },
            collapse_id: event.conversation_ref || notification_id, expiration: Math.floor(now() / 1000) + 24 * 3600 })
          : await sendPush(device.address, { id: notification_id, notice_id: `told:${item.seq}`, kind: event.kind, title: event.title, body: event.body, ...(event.open ? { open: event.open } : {}), actions: event.actions ?? [], tag: event.conversation_ref || notification_id }, { vapid, send });
        sent.push({ device, result });
      } catch {
        sent.push({ device, result: { sent: false, unknown: true } });
      }
    }
    for (const { device, result } of sent) if (result.gone) {
      const deviceRecordId = device.device_id.startsWith(DEVICE_PREFIX) ? device.device_id : `${DEVICE_PREFIX}${device.device_id}`;
      const record = await door.readRecord(DEVICE, deviceRecordId);
      if (record) await door.write([{ id: deviceRecordId, type: DEVICE, value: null, expected: { type: DEVICE, value: record.value } }], { key: `forget-gone-device:${deviceRecordId}:${route.attempt}` });
    }
    const priorDeviceResults = route.device_results ?? [];
    const latest = new Map(priorDeviceResults.map(result => [result.device_id, result]));
    for (const row of sent) latest.set(row.device.device_id, {
      device_id: row.device.device_id,
      stage: row.result.sent ? 'sent' : row.result.unknown ? 'uncertain' : 'not-sent',
      ...(row.result.status ? { status: row.result.status } : {}),
      ...(row.result.gone ? { gone: true } : {}),
    });
    const device_results = [...latest.values()];
    const acceptedDeviceIds = device_results.filter(result => result.stage === 'sent').map(result => result.device_id).filter(Boolean);
    const accepted = acceptedDeviceIds.length;
    const attempted = sent.length;
    const unknown = device_results.some(result => result.stage === 'uncertain');
    const retryableFailed = device_results.some(result => result.stage === 'not-sent');
    const label = route.route === 'apns' ? 'Apple' : 'The browser push service';
    const result = accepted > 0
      ? { sent: true, stage: retryableFailed ? 'partial' : 'sent', accepted, attempted, device_ids: acceptedDeviceIds, device_results, ...(unknown ? { uncertain: true } : {}), said: `${label} accepted the notice on ${accepted} registered devices; whether anyone read it is unknown.${retryableFailed ? ' Some definite failures may be retried.' : ''}` }
      : unknown ? { sent: false, stage: 'uncertain', accepted: 0, attempted, device_results, said: `${label}’s delivery outcome is unknown; it was not sent again.` }
        : { sent: false, stage: 'not-sent', accepted: 0, attempted, device_results, said: sent.map(row => row.result.said ?? row.result.error).filter(Boolean).join(' ') || `${label} did not accept the notice.` };
    await settleRoute(route.route, result, `finish-notification:${notification_id}:${route.attempt}`);
  }
  const final = ['apns', 'web-push'].map(route => item.results?.[route] ?? {});
  const delivered = final.some(result => result.sent === true || ['sent', 'partial'].includes(result.stage));
  const uncertain = final.some(result => ['attempting', 'uncertain'].includes(result.stage));
  const partial = final.some(result => result.stage === 'partial');
  const stage = partial ? 'partial' : delivered ? 'sent' : uncertain ? 'uncertain' : 'not-sent';
  return { notification_id, recorded: true, delivered, stage, said: delivered ? (partial ? 'At least one push provider accepted the notice and some definite device failures may be retried explicitly; the person may or may not have read it.' : 'At least one push provider accepted the notice; the person may or may not have read it.') : uncertain ? 'A push provider outcome is unknown; no uncertain delivery was sent again.' : final.map(result => result.said).filter(Boolean).join(' ') || 'No push provider accepted the notice.' };
}

function checkedActivityItems(items) {
  if (!Array.isArray(items) || items.length > 4) throw new Error('items must list at most four Live Activity items.');
  return items.map((item, index) => {
    if (!object(item)) throw new Error(`items[${index}] must be an object.`);
    const state = word(item.state, 20, `items[${index}].state`);
    if (!['running', 'done', 'failed', 'stopped'].includes(state)) throw new Error(`items[${index}].state must be running, done, failed or stopped.`);
    const capped = value => value == null ? '' : String(value).slice(0, 80);
    if (item.progress !== undefined && (!object(item.progress) || !Number.isFinite(item.progress.done) || !Number.isFinite(item.progress.total))) {
      throw new Error(`items[${index}].progress must give finite done and total numbers.`);
    }
    const progress = item.progress === undefined ? null
      : { done: item.progress.done, total: item.progress.total, ...(text(item.progress.unit) ? { unit: capped(item.progress.unit) } : {}), ...(text(item.progress.label) ? { label: capped(item.progress.label) } : {}) };
    return { id: word(item.id, 200, `items[${index}].id`), title: capped(word(item.title, 300, `items[${index}].title`)), body: capped(item.body ?? ''), state, open: item.open == null ? null : localPath(item.open, `items[${index}].open`),
      ...(text(item.source) ? { source: capped(item.source) } : {}), ...(progress ?? {}) };
  });
}

/** Updates/ends registered activity tokens, or starts once through push-to-start devices with a durable cooldown. */
export async function sendLiveActivityUpdate(input, { door, credentials = '', send, now = () => Date.now() } = {}) {
  const board_key = word(input?.board_key, 200, 'board_key');
  const update_id = word(input?.update_id, 200, 'update_id');
  const items = checkedActivityItems(input?.items);
  const receiptId = `${ACTIVITY_DELIVERY}:${idFor(`${board_key}\0${update_id}`)}`;
  const oldReceipt = await door.readRecord(ACTIVITY_DELIVERY, receiptId);
  if (oldReceipt?.value) {
    const old = oldReceipt.value;
    if (['attempting', 'uncertain'].includes(old.state)) return { board_key, update_id, state: old.state, accepted: old.accepted ?? 0, attempted: old.attempted ?? 0, said: 'The previous Apple delivery outcome is unknown; this update was not sent again.' };
    if (old.state === 'updated' || old.state === 'ended' || old.state === 'starting' || !input.retry_failed) return old.answer;
  }
  if (!items.length) {
    const activities = (await all(door, ACTIVITY, ACTIVITY_PREFIX)).some(row => row.value.board_key === board_key);
    if (!activities) {
      const answer = { board_key, update_id, state: 'not-running', accepted: 0, attempted: 0, said: 'Nothing is running to show.' };
      const value = { board_key, update_id, state: 'not-running', accepted: 0, attempted: 0, answer, started_at: new Date(now()).toISOString() };
      await door.write([{ id: receiptId, type: ACTIVITY_DELIVERY, value, expected: oldReceipt ? { type: ACTIVITY_DELIVERY, value: oldReceipt.value } : null }], { key: `empty-live-activity:${receiptId}:${idFor(value.started_at)}` });
      return answer;
    }
  }
  const key = apnsKey(credentials);
  const push = apnsPusher({ key, send, now });
  const timestamp = Math.floor(now() / 1000);
  const attempt = `${idFor(`${board_key}\0${update_id}`)}:${crypto.randomUUID()}`;
  const pending = { board_key, update_id, state: 'attempting', attempt, started_at: new Date(now()).toISOString() };
  await door.write([{ id: receiptId, type: ACTIVITY_DELIVERY, value: pending, expected: oldReceipt ? { type: ACTIVITY_DELIVERY, value: oldReceipt.value } : null }], { key: `claim-live-activity:${receiptId}:${attempt}` });
  const finish = async answer => {
    const value = { ...pending, state: answer.state, accepted: answer.accepted, attempted: answer.attempted, answer };
    await door.write([{ id: receiptId, type: ACTIVITY_DELIVERY, value, expected: { type: ACTIVITY_DELIVERY, value: pending } }], { key: `settle-live-activity:${receiptId}:${attempt}` });
    return answer;
  };
  const running = items.filter(item => item.state === 'running');
  const ended = running.length === 0;
  const content = { items, running: running.length };
  const activityRows = (await all(door, ACTIVITY, ACTIVITY_PREFIX)).filter(row => row.value.board_key === board_key);
  const startId = `${ACTIVITY_START}:${idFor(board_key)}`;
  const startRecord = await door.readRecord(ACTIVITY_START, startId);
  const previousStart = startRecord?.value?.started_at ? Date.parse(startRecord.value.started_at) : null;
  const oldActivities = activityRows.filter(row => {
    const keptAt = Date.parse(row.value.kept_at ?? '');
    return !Number.isFinite(keptAt) || now() - keptAt >= 7.5 * 60 * 60_000;
  });
  for (const row of oldActivities) {
    try {
      await push({ token: row.value.token, topic: `${row.value.app}.push-type.liveactivity`, environment: row.value.environment, push_type: 'liveactivity', priority: 10,
        payload: { aps: { timestamp, event: 'end', 'content-state': content, 'dismissal-date': timestamp } } });
    } catch { /* The token is beyond iOS's update window; retire it even if APNs no longer answers. */ }
    await door.write([{ id: row.id, type: ACTIVITY, value: null, expected: { type: ACTIVITY, value: row.value } }], { key: `expire-live-activity:${row.id}:${timestamp}` });
  }
  const activeRows = activityRows.filter(row => !oldActivities.includes(row));
  if (activeRows.length) {
    const outcomes = [];
    for (const row of activeRows) {
      let result;
      try {
        result = await push({ token: row.value.token, topic: `${row.value.app}.push-type.liveactivity`, environment: row.value.environment, push_type: 'liveactivity', priority: ended ? 10 : 5,
          payload: { aps: { timestamp, event: ended ? 'end' : 'update', 'content-state': content, ...(ended ? { 'dismissal-date': timestamp + 900 } : { 'stale-date': timestamp + 10 * 60 }) } } });
      } catch { result = { sent: false, unknown: true, error: 'The Apple delivery outcome is unknown.' }; }
      outcomes.push({ row, result });
      if (result.gone || (ended && result.sent)) await door.write([{ id: row.id, type: ACTIVITY, value: null, expected: { type: ACTIVITY, value: row.value } }], { key: `retire-activity:${row.id}:${timestamp}` });
    }
    const accepted = outcomes.filter(outcome => outcome.result.sent).length;
    const state = outcomes.some(outcome => outcome.result.unknown) && accepted === 0 ? 'uncertain' : ended ? 'ended' : 'updated';
    return await finish({ board_key, update_id, state, accepted, attempted: outcomes.length, uncertain: outcomes.some(outcome => outcome.result.unknown), said: ended ? (accepted ? 'The Live Activity was ended on Apple devices.' : 'The Live Activity end was not confirmed.') : `The Live Activity update was accepted on ${accepted} of ${outcomes.length} Apple devices.` });
  }
  if (ended) return await finish({ board_key, update_id, state: 'not-running', accepted: 0, attempted: 0, said: 'Nothing is running to show.' });
  if (previousStart && now() - previousStart < 15 * 60_000) return await finish({ board_key, update_id, state: 'waiting-for-token', accepted: 0, attempted: 0, said: 'A Live Activity start is still waiting for its token; it was not started twice.' });
  const startDevices = (await all(door, DEVICE, DEVICE_PREFIX)).map(row => row.value).filter(row => row.route === 'apns-activity' && row.can_show !== 'denied' && row.can_show !== 'quiet');
  if (!startDevices.length) return await finish({ board_key, update_id, state: 'unavailable', accepted: 0, attempted: 0, said: 'No iPhone is registered for Live Activity push-to-start.' });
  const invalidTypeDevice = startDevices.find(device => {
    try { activityAttributesType(device.attributes_type); return false; } catch { return true; }
  });
  if (invalidTypeDevice) return await finish({ board_key, update_id, state: 'unavailable', accepted: 0, attempted: 0, said: 'A registered iPhone has no valid Live Activity attributes_type; update its registration before starting the activity.' });
  const priorValue = startRecord?.value;
  const startValue = { board_key, started_at: new Date(now()).toISOString() };
  await door.write([{ id: startId, type: ACTIVITY_START, value: startValue, expected: startRecord ? { type: ACTIVITY_START, value: priorValue } : null }], { key: `start-live-activity:${startId}:${startValue.started_at}` });
  const outcomes = [];
  for (const device of startDevices) {
    try {
      const result = await push({ token: device.address, topic: `${word(device.app, 200, 'registered app')}.push-type.liveactivity`, environment: device.environment, push_type: 'liveactivity', priority: 5,
        payload: { aps: { timestamp, event: 'start', 'content-state': content, 'attributes-type': activityAttributesType(device.attributes_type), attributes: { key: board_key }, 'stale-date': timestamp + 600, alert: { title: items[0]?.title ?? 'Work is running', body: items[0]?.body ?? '' } } } });
      outcomes.push(result);
    } catch { outcomes.push({ sent: false, unknown: true, error: 'The Apple delivery outcome is unknown.' }); }
  }
  const accepted = outcomes.filter(result => result.sent).length;
  const uncertainStart = outcomes.some(result => result.unknown);
  if (!accepted && !uncertainStart) {
    const latest = await door.readRecord(ACTIVITY_START, startId);
    if (latest?.value?.started_at === startValue.started_at) {
      await door.write([{ id: startId, type: ACTIVITY_START, value: null, expected: { type: ACTIVITY_START, value: latest.value } }], { key: `release-live-activity-start:${startId}:${attempt}` });
    }
  }
  const state = accepted ? 'starting' : uncertainStart ? 'uncertain' : 'not-sent';
  return await finish({ board_key, update_id, state, accepted, attempted: outcomes.length,
    said: accepted ? 'Apple accepted the Live Activity start; the app must return its activity token before updates can be sent.' : uncertainStart ? 'Apple’s start outcome is unknown; it will not be started again during the waiting period.' : outcomes.map(result => result.error).filter(Boolean).join(' ') || 'Apple did not accept the Live Activity start.' });
}

export const heldNotificationSigningKeys = (fd = 4, read) => readSigningKeys(fd, read);

export const myBrowserPushApplicationServerKeyFromHeldCredential = (input, context) => {
  const keys = readSigningKeys();
  return myBrowserPushApplicationServerKey(input, { ...context, webCredentials: keys.web_push });
};
export const sendNotificationWithHeldApnsKey = (input, context) => {
  const keys = readSigningKeys();
  return sendNotificationToMyDevices(input, { ...context, credentials: keys.apns, webCredentials: keys.web_push });
};
export const sendLiveActivityWithHeldApnsKey = (input, context) => {
  const keys = readSigningKeys();
  return sendLiveActivityUpdate(input, { ...context, credentials: keys.apns });
};
