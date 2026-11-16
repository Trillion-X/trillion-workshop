// Device registration and the two senders (notice, Live Activity) for tools/notifications. The senders take the notice,
// devices and tokens as input, answer what each provider said, and keep nothing. Provider keys come on the credential pipe.
import { readFileSync } from 'node:fs';
import DELIVERY from './delivery-contract.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { base64url as browserBase64url, applicationServerKey, checkedSubscription, sendPush } from './web-push.mjs';
import { requestHttp2 } from './http2-request.mjs';

export const DEVICE = 'notification-device';
export const ACTIVITY = 'notification-live-activity';
const DEVICE_PREFIX = `${DEVICE}:`;
const ACTIVITY_PREFIX = `${ACTIVITY}:`;
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

const canShow = device => object(device) && device.can_show !== 'denied' && device.can_show !== 'quiet';

function checkedDevices(devices) {
  if (!Array.isArray(devices) || devices.length > 40 || !devices.every(object)) throw new Error('devices must list at most 40 registered devices, each as an object.');
  return devices;
}

/**
 * Sends one notice to the registered devices the caller passes, and answers what each provider said. Nothing is kept:
 * the caller holds the notice and its devices and decides what to send again. A device whose provider says it is gone is
 * named in gone_device_ids, and one whose outcome is unknown is stage uncertain; send neither again without checking.
 */
export async function sendNotificationToMyDevices(input, { credentials = '', webCredentials = '', send, now = () => Date.now() } = {}) {
  const event = input?.notification;
  if (!object(event)) throw new Error('Pass the notification as an object in notification.');
  const notification_id = word(event.notification_id, 200, 'notification.notification_id');
  const audience = word(input.audience, 200, 'audience');
  if (!Array.isArray(event.audience_refs) || !event.audience_refs.includes(audience)) throw new Error(`The notification ${notification_id} does not name ${audience} in audience_refs.`);
  const title = word(event.title, 300, 'notification.title');
  const body = word(event.body, 4000, 'notification.body');
  const devices = checkedDevices(input.devices).filter(canShow);
  const live_device_ids = devices.filter(device => device.route === 'live').map(device => device.device_id).filter(Boolean);
  const routes = [
    { route: 'apns', label: 'Apple', devices: devices.filter(device => device.route === 'apns') },
    { route: 'web-push', label: 'The browser push service', devices: devices.filter(device => device.route === 'web-push') },
  ].filter(candidate => candidate.devices.length > 0);
  let apnsPush;
  let vapid;
  try { if (routes.some(candidate => candidate.route === 'apns')) apnsPush = apnsPusher({ key: credentials, send, now }); }
  catch { /* The route is answered as unavailable below; credential errors are never copied into the answer. */ }
  try { if (routes.some(candidate => candidate.route === 'web-push')) vapid = webPushKey(webCredentials); }
  catch { /* The route is answered as unavailable below; credential errors are never copied into the answer. */ }
  const answered = {};
  const gone_device_ids = [];
  const deviceActions = (Array.isArray(event.actions) ? event.actions : []).map(action => ({
    id: action.id, label: action.label,
    ...(object(action.input) ? { input: action.input } : {}),
    ...(action.opens === true || action.press === true ? { opens: true } : {}),
    ...(action.destructive === true ? { destructive: true } : {}),
  }));
  const category = deviceActions.length ? [DELIVERY.apns_category_prefix, ...deviceActions.map(action => action.id)].join('.') : undefined;
  for (const candidate of routes) {
    if (candidate.route === 'apns' && !apnsPush || candidate.route === 'web-push' && !vapid) {
      answered[candidate.route] = { sent: false, stage: 'unavailable', said: `The ${candidate.route === 'apns' ? 'Apple' : 'browser'} push key is not available to this run.` };
      continue;
    }
    const sent = [];
    for (const device of candidate.devices) {
      try {
        const result = candidate.route === 'apns'
          ? await apnsPush({ token: device.address, topic: word(device.app, 200, 'registered app'), environment: device.environment,
            payload: { aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'active', 'mutable-content': 1,
              'thread-id': event.conversation_ref || event.kind, ...(category ? { category } : {}) },
            [DELIVERY.apns_payload_key]: { id: notification_id, notification_id, kind: event.kind, open: event.open ?? null, actions: deviceActions } },
            collapse_id: event.conversation_ref || notification_id, expiration: Math.floor(now() / 1000) + 24 * 3600 })
          : await sendPush(device.address, { id: notification_id, notice_id: notification_id, kind: event.kind, title, body, ...(event.open ? { open: event.open } : {}), actions: event.actions ?? [], tag: event.conversation_ref || notification_id }, { vapid, send });
        sent.push({ device, result });
      } catch {
        sent.push({ device, result: { sent: false, unknown: true } });
      }
    }
    for (const { device, result } of sent) if (result.gone && device.device_id) gone_device_ids.push(device.device_id);
    const device_results = sent.map(({ device, result }) => ({
      device_id: device.device_id,
      stage: result.sent ? 'sent' : result.unknown ? 'uncertain' : 'not-sent',
      ...(result.status ? { status: result.status } : {}),
      ...(result.gone ? { gone: true } : {}),
    }));
    const accepted = device_results.filter(result => result.stage === 'sent').length;
    const unknown = device_results.some(result => result.stage === 'uncertain');
    const failed = device_results.some(result => result.stage === 'not-sent');
    answered[candidate.route] = accepted > 0
      ? { sent: true, stage: failed ? 'partial' : 'sent', accepted, attempted: sent.length, device_results, ...(unknown ? { uncertain: true } : {}), said: `${candidate.label} accepted the notice on ${accepted} registered devices; whether anyone read it is unknown.${failed ? ' Some definite failures may be sent again.' : ''}` }
      : unknown ? { sent: false, stage: 'uncertain', accepted: 0, attempted: sent.length, device_results, said: `${candidate.label}’s delivery outcome is unknown; check before sending again.` }
        : { sent: false, stage: 'not-sent', accepted: 0, attempted: sent.length, device_results, said: sent.map(row => row.result.said ?? row.result.error).filter(Boolean).join(' ') || `${candidate.label} did not accept the notice.` };
  }
  const final = Object.values(answered);
  const delivered = final.some(result => result.sent === true);
  const uncertain = final.some(result => result.stage === 'uncertain');
  const partial = final.some(result => result.stage === 'partial');
  const stage = partial ? 'partial' : delivered ? 'sent' : uncertain ? 'uncertain' : 'not-sent';
  return {
    notification_id, delivered, stage, routes: answered, live_device_ids, gone_device_ids,
    said: delivered ? (partial ? 'At least one push provider accepted the notice and some definite device failures may be sent again; the person may or may not have read it.' : 'At least one push provider accepted the notice; the person may or may not have read it.')
      : uncertain ? 'A push provider outcome is unknown; check before sending again.'
        : final.map(result => result.said).filter(Boolean).join(' ') || 'No push provider has a registered device for this notice.',
  };
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

function checkedActivities(activities, board_key) {
  if (activities === undefined) return [];
  if (!Array.isArray(activities) || activities.length > 200 || !activities.every(object)) throw new Error('activities must list the registered Live Activity tokens as objects.');
  return activities.filter(row => row.board_key === board_key).map((row, index) => {
    const token = word(row.token, 400, `activities[${index}].token`).toLowerCase();
    if (!/^[0-9a-f]{32,400}$/.test(token)) throw new Error('A Live Activity token must be the hex token its system gave it.');
    return { id: word(row.id, 300, `activities[${index}].id`), token, app: word(row.app, 200, `activities[${index}].app`), environment: row.environment, kept_at: row.kept_at };
  });
}

/**
 * Updates or ends the Live Activity tokens the caller passes, or starts one through the push-to-start devices the caller
 * passes. Nothing is kept: retired_activity_ids names the tokens to forget (gone, ended or past iOS's update window), and
 * started_at is when a start was sent, to be passed back as last_start_at so a start is not sent twice while it waits.
 */
export async function sendLiveActivityUpdate(input, { credentials = '', send, now = () => Date.now() } = {}) {
  const board_key = word(input?.board_key, 200, 'board_key');
  const update_id = word(input?.update_id, 200, 'update_id');
  const items = checkedActivityItems(input?.items);
  const activityRows = checkedActivities(input.activities, board_key);
  if (!items.length && !activityRows.length) return { board_key, update_id, state: 'not-running', accepted: 0, attempted: 0, retired_activity_ids: [], said: 'Nothing is running to show.' };
  const push = apnsPusher({ key: apnsKey(credentials), send, now });
  const timestamp = Math.floor(now() / 1000);
  const running = items.filter(item => item.state === 'running');
  const ended = running.length === 0;
  const content = { items, running: running.length };
  const retired_activity_ids = [];
  const oldActivities = activityRows.filter(row => {
    const keptAt = Date.parse(row.kept_at ?? '');
    return !Number.isFinite(keptAt) || now() - keptAt >= 7.5 * 60 * 60_000;
  });
  for (const row of oldActivities) {
    try {
      await push({ token: row.token, topic: `${row.app}.push-type.liveactivity`, environment: row.environment, push_type: 'liveactivity', priority: 10,
        payload: { aps: { timestamp, event: 'end', 'content-state': content, 'dismissal-date': timestamp } } });
    } catch { /* The token is beyond iOS's update window; retire it even if APNs no longer answers. */ }
    retired_activity_ids.push(row.id);
  }
  const activeRows = activityRows.filter(row => !oldActivities.includes(row));
  if (activeRows.length) {
    const outcomes = [];
    for (const row of activeRows) {
      let result;
      try {
        result = await push({ token: row.token, topic: `${row.app}.push-type.liveactivity`, environment: row.environment, push_type: 'liveactivity', priority: ended ? 10 : 5,
          payload: { aps: { timestamp, event: ended ? 'end' : 'update', 'content-state': content, ...(ended ? { 'dismissal-date': timestamp + 900 } : { 'stale-date': timestamp + 10 * 60 }) } } });
      } catch { result = { sent: false, unknown: true, error: 'The Apple delivery outcome is unknown.' }; }
      outcomes.push(result);
      if (result.gone || (ended && result.sent)) retired_activity_ids.push(row.id);
    }
    const accepted = outcomes.filter(result => result.sent).length;
    const state = outcomes.some(result => result.unknown) && accepted === 0 ? 'uncertain' : ended ? 'ended' : 'updated';
    return { board_key, update_id, state, accepted, attempted: outcomes.length, uncertain: outcomes.some(result => result.unknown), retired_activity_ids, said: ended ? (accepted ? 'The Live Activity was ended on Apple devices.' : 'The Live Activity end was not confirmed.') : `The Live Activity update was accepted on ${accepted} of ${outcomes.length} Apple devices.` };
  }
  const nothingSent = (state, said) => ({ board_key, update_id, state, accepted: 0, attempted: 0, retired_activity_ids, said });
  if (ended) return nothingSent('not-running', 'Nothing is running to show.');
  const previousStart = input.last_start_at === undefined ? null : Date.parse(input.last_start_at);
  if (input.last_start_at !== undefined && !Number.isFinite(previousStart)) throw new Error('last_start_at must be the time a start was sent, as an ISO date.');
  if (previousStart && now() - previousStart < 15 * 60_000) return nothingSent('waiting-for-token', 'A Live Activity start is still waiting for its token; it was not started twice.');
  const startDevices = checkedDevices(input.devices ?? []).filter(device => device.route === 'apns-activity' && canShow(device));
  if (!startDevices.length) return nothingSent('unavailable', 'No iPhone is registered for Live Activity push-to-start.');
  const invalidTypeDevice = startDevices.find(device => {
    try { activityAttributesType(device.attributes_type); return false; } catch { return true; }
  });
  if (invalidTypeDevice) return nothingSent('unavailable', 'A registered iPhone has no valid Live Activity attributes_type; update its registration before starting the activity.');
  const started_at = new Date(now()).toISOString();
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
  const state = accepted ? 'starting' : uncertainStart ? 'uncertain' : 'not-sent';
  return {
    board_key, update_id, state, accepted, attempted: outcomes.length, retired_activity_ids,
    ...(accepted || uncertainStart ? { started_at } : {}),
    said: accepted ? 'Apple accepted the Live Activity start; the app must return its activity token before updates can be sent.' : uncertainStart ? 'Apple’s start outcome is unknown; do not start it again during the waiting period.' : outcomes.map(result => result.error).filter(Boolean).join(' ') || 'Apple did not accept the Live Activity start.',
  };
}

export const heldNotificationSigningKeys = (fd = 4, read) => readSigningKeys(fd, read);

// These three rows mount no records door, so the run's context is not spread (spreading it reads its `door`, which
// opens descriptor 3, and a run with none fails ENXIO).
export const myBrowserPushApplicationServerKeyFromHeldCredential = (input) => {
  const keys = readSigningKeys();
  return myBrowserPushApplicationServerKey(input, { webCredentials: keys.web_push });
};
export const sendNotificationWithHeldApnsKey = (input) => {
  const keys = readSigningKeys();
  return sendNotificationToMyDevices(input, { credentials: keys.apns, webCredentials: keys.web_push });
};
export const sendLiveActivityWithHeldApnsKey = (input) => {
  const keys = readSigningKeys();
  return sendLiveActivityUpdate(input, { credentials: keys.apns });
};
