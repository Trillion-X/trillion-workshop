// tools/tell-the-person/read-data/told.mjs
//
// What Trillion told the person, read from their own records through the run's records door (tools/records-door).
// The told list is records of the kind `told-the-person`: one head record `told-the-person` naming the kept notices
// in order ({ seqs: [seq, ...] }) and one record `told-the-person:<seq>` per notice ({ item }). A head written by an
// earlier version holds the whole list as `items` and is read as it is.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export const KIND = 'told-the-person';
const HEAD = KIND;
const DEVICE_KIND = 'notification-device';
const MOST = 100;
const USUAL = 20;
const WHY_CHARACTERS = 200;

async function keptNotices(door) {
  const held = new Map();
  for await (const record of door.list({ type: KIND })) held.set(record.id, record.value);
  const head = held.get(HEAD) ?? {};
  if (Array.isArray(head.items)) return head.items;
  return (head.seqs ?? []).map(seq => held.get(`${HEAD}:${seq}`)?.item).filter(Boolean);
}

async function keptRows(door) {
  const held = new Map();
  for await (const record of door.list({ type: KIND })) held.set(record.id, record);
  return held;
}

/**
 * tool:my-notices: the newest notices, optionally of one kind (the kind is applied before the newest are taken), with
 * where the person saw each one, how far each way got, and why each way that did not carry it did not.
 */
export async function myNotices({ limit = USUAL, kind = null } = {}, { door }) {
  const most = Math.max(1, Math.min(MOST, Number(limit) || USUAL));
  const notices = (await keptNotices(door)).filter(item => !kind || item.kind === kind).slice(-most).reverse().map(item => {
    const results = item.results ?? {};
    const told = Object.fromEntries(Object.entries(results).map(([channel, result]) => [channel, result.sent ? 'sent' : result.stage ?? 'not-sent']));
    const why = Object.fromEntries(Object.entries(results).filter(([, result]) => !result.sent && result.said).map(([channel, result]) => [channel, String(result.said).slice(0, WHY_CHARACTERS)]));
    return {
      id: `told:${item.seq}`, kind: item.kind, title: item.title ?? null, body: item.body ?? '', at: item.at ?? null, open: item.open ?? null, read: Boolean(item.read),
      actions: Array.isArray(item.actions) ? item.actions : [],
      ...(item.read_on ? { read_on: item.read_on } : {}), told, ...(Object.keys(why).length ? { why } : {}),
    };
  });
  const seen = notices.filter(item => item.read).length;
  return { notices, said: `${notices.length} ${notices.length === 1 ? 'notice' : 'notices'}, newest first; ${seen} seen.` };
}

/** A registered device reads only the notices queued or positively delivered to that device. */
export async function myDeviceNotices(input = {}, { door }) {
  const device_id = typeof input.device_id === 'string' ? input.device_id.trim() : '';
  if (!device_id) throw new Error('Name this registered device by its device_id.');
  const device = await door.readRecord(DEVICE_KIND, `${DEVICE_KIND}:${device_id}`);
  if (!device || !['live', 'web-push', 'apns'].includes(device.value?.route)) throw new Error('This device is not registered to read notices.');
  const channel = typeof input.channel === 'string' && input.channel.trim() ? input.channel.trim() : (device.value.route === 'live' ? 'device-pull' : device.value.route);
  const channelRoute = { 'device-pull': 'live', 'mac-app': 'live', 'mac-voice': 'live', 'web-push': 'web-push', apns: 'apns' };
  if (channelRoute[channel] !== device.value.route) throw new Error(`channel ${channel} does not match this registered device route.`);
  const after = Number.isSafeInteger(input.after) && input.after >= 0 ? input.after : 0;
  const limit = Math.max(1, Math.min(MOST, Number(input.limit) || USUAL));
  const allNotices = await keptNotices(door);
  const resultFor = item => item.results?.[channel] ?? (channel === 'mac-app' ? item.results?.['device-pull'] : null);
  const notices = allNotices.filter(item => {
    if (!(Number(item.seq) > after)) return false;
    const result = resultFor(item);
    if (!result) return false;
    // Exact per-device receipts prevent a registered browser or phone from reading notices delivered elsewhere.
    // Legacy device-pull items were queued to all registered live devices only when their result says queued/sent.
    if (Array.isArray(result.device_ids)) return result.device_ids.includes(device_id);
    const registeredAt = Date.parse(device.value.added_at ?? '');
    const noticeAt = Date.parse(item.at ?? '');
    return channelRoute[channel] === 'live' && ['device-pull', 'mac-app', 'mac-voice'].includes(channel)
      && (result.sent === true || result.stage === 'queued')
      && !(Number.isFinite(registeredAt) && Number.isFinite(noticeAt) && registeredAt > noticeAt);
  })
    .slice(0, limit).map(item => ({
      id: `told:${item.seq}`, seq: item.seq, kind: item.kind, title: item.title ?? '', body: item.body ?? '',
      open: item.open ?? null, at: item.at ?? null, read: Boolean(item.read), actions: Array.isArray(item.actions) ? item.actions : [],
      level: item.level ?? 'active', ...(item.group ? { group: item.group } : {}), ...(item.read_on ? { read_on: item.read_on } : {}),
    }));
  // Do not move past a notice whose device route is still being attempted: it may become readable after this poll.
  // Notices without this route, and settled failures/acceptances, are safe to advance past.
  let cursor = after;
  for (const item of allNotices.filter(item => Number(item.seq) > after).sort((a, b) => Number(a.seq) - Number(b.seq))) {
    if (['checking', 'attempting'].includes(resultFor(item)?.stage)) break;
    cursor = Math.max(cursor, Number(item.seq) || cursor);
  }
  if (notices.length === limit) cursor = Math.min(cursor, Number(notices.at(-1)?.seq) || cursor);
  return { device_id, channel, cursor, notices, said: `${notices.length} ${notices.length === 1 ? 'notice is' : 'notices are'} ready for this device, oldest first.` };
}

/** Opens only a destination explicitly offered by this notice; effectful source actions need their owning host road. */
export async function actOnMyNotice(input = {}, { door }) {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const actionId = typeof input.action === 'string' ? input.action.trim() : '';
  if (!/^told:\d+$/.test(id) || !actionId) throw new Error('Name the notice id and one offered action id.');
  if (input.submission_id !== undefined && (typeof input.submission_id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.submission_id))) throw new Error('submission_id must be a UUID so a retry is the same press.');
  if (input.text !== undefined && typeof input.text !== 'string') throw new Error('text must be words.');
  const seq = Number(id.slice('told:'.length));
  const item = (await keptNotices(door)).find(notice => Number(notice.seq) === seq);
  if (!item || Number(item.seq) !== seq) throw new Error('There is no such notice.');
  const offered = Array.isArray(item.actions) ? item.actions.find(action => action?.id === actionId) : null;
  if (!offered) throw new Error('That action was not offered by this notice.');

  // A self-contained open action can return its own local path. `opens: true` on a tell-the-person action is only a
  // post-road navigation hint; its configured road must succeed first, so this tool cannot treat it as the action.
  if (offered.post !== undefined) throw new Error('This action must be performed by its source app; no matching action owner is available in this tool run.');
  const destination = typeof offered.open === 'string' ? offered.open : null;
  if (destination && /^\/(?![/\\])[^\\]*$/.test(destination)) {
    // The source open road succeeds before act() marks the notice read. Use the same CAS mark so an open retry is
    // idempotent, and return the navigation only after its read receipt has been kept.
    await markMyNoticesRead({ ids: [id] }, { door });
    return { done: true, said: offered.label ? `Opening ${offered.label}.` : 'Opening the notice.', open: destination };
  }
  if (offered.opens === true) throw new Error('This action needs its configured source road to run before opening; it was not performed.');
  throw new Error('This action needs its source owner to act; it was not performed.');
}

const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const identity = value => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(sorted(value))));

/** The first surface a person saw is kept. A repeated read is idempotent and cannot move that evidence. */
export async function markMyNoticesRead(input = {}, { door, now = () => new Date() }) {
  const read = input.read !== false;
  if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.every(id => typeof id === 'string' && /^told:\d+$/.test(id)))) throw new Error('ids must be a list of told:<number> notice ids.');
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids)] : [];
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (!ids.length && !key) throw new Error('Name one or more notice ids, or the notification key, to mark read.');
  const surfaceInput = input.on && typeof input.on === 'object' && !Array.isArray(input.on) ? input.on : null;
  const channel = surfaceInput?.here === true ? 'in-app' : typeof surfaceInput?.channel === 'string' ? surfaceInput.channel.trim() : '';
  const surface = read && ['in-app', 'this-computer', 'phone', 'watch', 'browser', 'mac-app', 'mac-voice', 'apns', 'web-push', 'device-pull'].includes(channel)
    ? { channel, ...(typeof surfaceInput.device_id === 'string' && surfaceInput.device_id.trim() ? { device_id: surfaceInput.device_id.trim().slice(0, 200) } : {}), at: now().toISOString() }
    : null;
  const held = await keptRows(door);
  const headRecord = held.get(HEAD);
  const head = headRecord?.value ?? {};
  const legacy = Array.isArray(head.items);
  const items = legacy ? head.items : (head.seqs ?? []).map(seq => held.get(`${KIND}:${seq}`)?.value?.item).filter(Boolean);
  const wanted = new Set(ids);
  const selected = items.filter(item => wanted.has(`told:${item.seq}`) || (key && item.key === key));
  const writes = [];
  if (legacy && headRecord) {
    const next = items.map(item => {
      if (!selected.some(chosen => chosen.seq === item.seq)) return item;
      const { read_on: priorSurface, ...rest } = item;
      if (!read) return { ...rest, read: false };
      const first = priorSurface ?? surface;
      return { ...rest, read: true, ...(first ? { read_on: first } : {}) };
    });
    if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(items))) writes.push({ id: HEAD, type: KIND, value: { ...head, items: next }, expected: { type: KIND, value: headRecord.value } });
  } else {
    for (const item of selected) {
      const id = `${KIND}:${item.seq}`;
      const record = held.get(id);
      if (!record || !record.value?.item) continue;
      const { read_on: priorSurface, ...rest } = item;
      const updated = read ? { ...rest, read: true, ...(priorSurface ? { read_on: priorSurface } : surface ? { read_on: surface } : {}) } : { ...rest, read: false };
      if (JSON.stringify(sorted(updated)) !== JSON.stringify(sorted(item))) writes.push({ id, type: KIND, value: { item: updated }, expected: { type: KIND, value: record.value } });
    }
  }
  if (writes.length) await door.write(writes, { key: `mark-my-notices-read:${identity({ ids: selected.map(item => item.seq), read, on: surface })}` });
  return { ids: selected.map(item => `told:${item.seq}`), read, changed: writes.length > 0, ...(surface ? { on: surface } : {}), said: `${selected.length} ${selected.length === 1 ? 'notice' : 'notices'} ${read ? 'marked read' : 'marked unread'}.` };
}
