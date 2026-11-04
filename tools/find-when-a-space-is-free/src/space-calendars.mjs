// src/space-calendars.mjs
//
// Purpose
//   The calendars of a space's members, used together. Each member's own account shares only when they are busy (each
//   stretch's start and end) with the spaces they are in, unless they turn it off for a space; find_space_times reads
//   every member's busy stretches through their own accounts and answers the times everyone is free, saying plainly
//   whose calendar is not known. A meeting put on in a space (create_community_event, or the meetings tool:hold-to-it
//   books) is placed on each member's own calendar through their own connection, once per meeting; when it moves it
//   moves there, and when a member stops going it is cancelled there.
//
//   Three sides, one file:
//     freeTimes(...)              pure: the open starts in a stretch, given every busy stretch (calendar-booker's
//                                 derive-open-slots does the subtracting, the same derivation availability links use)
//     findSpaceTimes(input, io)   the asker's side, in their own store: asks each member's store, then freeTimes
//     memberCalendar(io)          a member's side, in their own store: their choice per space, their busy stretches,
//                                 the space meetings placed on their calendar, and the connect step Trillion gives
//                                 them when their calendar is not connected (askToConnect)
//     spaceEventCalendarMethods   the space's side, mixed into the Network: tells each member's store about a meeting
//
// Non-Negotiable Invariants
//   1. Only start and end leave a member's account: never a title, a place, a guest or any other detail of what they
//      are busy with (busyStretches reads only the two fields the calendar row names).
//   2. A calendar that is not connected, not shared or could not be read is said as such (connected: false,
//      shares: false, read: false) and never counted as free; the times answer says how many people it covers.
//   3. Who may ask is the space's own rules (action see_when_members_are_busy, src/space-permission-rules.json); each
//      member's store also checks the asker is in the space with them before it reads anything, and its own choice.
//   4. A meeting is placed on a member's calendar once: one record per meeting in the member's own store, and every
//      change to one meeting runs after the one before it, so a quick move never makes a second event.
//   5. The kinds of calendar, their tools and reply fields, and every word are DATA (src/space-calendars.json); nothing
//      here names a calendar service, a space or a person. Calendar calls go through the member's own Workshop tools,
//      so their connection's values never leave their locked box.
//   6. A member whose calendar is not connected is asked by Trillion itself, never by whoever searched: one thing given
//      to them in the space (settings.ask), placed by Trillion (origin trillion), per member and kind of calendar across
//      all their spaces. While one is open nothing more is placed; it carries a `connects` fact, so it is done by itself
//      once the member has that calendar connected, by whatever road they connected it (src/waiting-on-you.json
//      `done_when_connected`). Their own store checks the asker is in the space with them and that they are truly not
//      connected before it places anything.
//
import settings from './space-calendars.json' with { type: 'json' };
import { quietHoursAnswer } from '../../run-work-later-or-on-a-repeat/do-work/quiet-hours.ts';
import { deriveOpenSlots } from '../../booking-slots-and-invitations/do-work/derive-open-slots.ts';
import { timeZoneName } from '../../run-work-later-or-on-a-repeat/do-work/wall-time.ts';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** The value at a path of keys, where an object segment picks the array element whose fields all match it. */
function valueAt(record, path) {
  let here = record;
  for (const segment of path ?? []) {
    if (here === null || here === undefined) return undefined;
    if (segment !== null && typeof segment === 'object') {
      if (!Array.isArray(here)) return undefined;
      here = here.find(item => item && Object.entries(segment).every(([key, value]) => item[key] === value));
    } else here = here[segment];
  }
  return here;
}
/** A moment in words in one time zone: "Thursday, October 15 at 9:00 AM PDT". */
function timeWords(ms, timezone) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(part => part.type === 'timeZoneName')?.value ?? timezone;
  return `${when} ${zone}`;
}
/** The busy stretches in a calendar's busy reply, read through the calendar row's `reply` paths and field names, and
 * whether the calendar said it could not be read (`fields.errors`). */
function busyStretches(spec, output) {
  const fields = spec.reply?.fields ?? {};
  const found = [];
  let refused = false;
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isObject(value)) {
      if (fields.errors && Array.isArray(value[fields.errors]) && value[fields.errors].length) refused = true;
      if (typeof value[fields.start] === 'string') found.push({ start_ms: Date.parse(value[fields.start]), end_ms: Date.parse(value[fields.end]) });
      else Object.values(value).forEach(walk);
    }
  };
  walk(valueAt(output, spec.reply?.busy));
  return { refused, busy: found.filter(block => Number.isFinite(block.start_ms) && Number.isFinite(block.end_ms)) };
}

const { words, defaults, limits } = settings;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const say = (key, values = {}) => fill(words[key], values);
const iso = ms => new Date(ms).toISOString();
// What a calendar change asks for: a retry of the same change reuses its key, a different change gets a new one.
const fingerprint = input => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(input)))).slice(0, 16);
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export class SpaceCalendarError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const dateIn = (ms, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (dateISO, days) => { const [y, m, d] = dateISO.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };

/** Every open start of `durationMin` minutes from `fromMs` to `toMs`, between `earliest` and `latest` each day in
 *  `timeZone`, that overlaps no busy stretch; at most `most`, earliest first. */
export function freeTimes({ busy, fromMs, toMs, durationMin, stepMin = defaults.step_minutes, earliest = defaults.earliest, latest = defaults.latest, timeZone = defaults.time_zone, nowMs = fromMs, most = limits.most_times }) {
  const windows = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: earliest, end: latest }));
  const blocked = busy.map(stretch => ({ startMs: stretch.start_ms, endMs: stretch.end_ms }));
  const times = [];
  for (let date = dateIn(fromMs, timeZone), last = dateIn(toMs, timeZone); date <= last && times.length < most; date = addDays(date, 1)) {
    for (const slot of deriveOpenSlots({ timezone: timeZone, windows, dateISO: date, durationMin, stepMin, nowMs, busy: blocked })) {
      if (slot.startMs < fromMs || slot.endMs > toMs) continue;
      times.push({ start: iso(slot.startMs), end: iso(slot.endMs), when: timeWords(slot.startMs, timeZone) });
      if (times.length >= most) break;
    }
  }
  return times;
}

// What find_space_times was asked, checked and filled from the defaults.
function searchOf(input, nowMs) {
  const fromMs = input.from === undefined ? nowMs : Date.parse(input.from);
  const toMs = input.to === undefined ? fromMs + defaults.days * DAY_MS : Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > limits.longest_days * DAY_MS) throw new SpaceCalendarError(say('bad_stretch', { days: limits.longest_days }));
  const durationMin = input.duration_minutes ?? defaults.duration_minutes;
  if (!Number.isInteger(durationMin) || durationMin < limits.shortest_minutes || durationMin > limits.longest_minutes) throw new SpaceCalendarError(say('bad_minutes', { shortest: limits.shortest_minutes, longest: limits.longest_minutes }));
  const earliest = input.earliest ?? defaults.earliest;
  const latest = input.latest ?? defaults.latest;
  for (const [field, value] of [['earliest', earliest], ['latest', latest]]) if (typeof value !== 'string' || !HH_MM.test(value)) throw new SpaceCalendarError(say('bad_time', { field }));
  const timeZone = timeZoneName(input.time_zone ?? defaults.time_zone);
  if (!timeZone) throw new SpaceCalendarError(say('bad_zone'));
  return { fromMs: Math.max(fromMs, nowMs), toMs, durationMin, earliest, latest, timeZone };
}

// How a member who is not connected connects: the person asking gets the call that makes their own link; anyone else
// is pointed at the Connections screen in their own account. `page` is the page that connects it for whoever is signed in.
const connectPage = (service, origin) => `${origin ?? ''}${fill(settings.connect.page, { service: encodeURIComponent(service) })}`;
const connectScreen = (service, origin) => `${origin ?? ''}${fill(settings.connect.screen, { service: encodeURIComponent(service) })}`;
const connectFor = (member, origin) => (member.you
  ? { service: settings.calendars[0].service, next_call: { tool: settings.connect.tool, arguments: { service: settings.calendars[0].service } }, screen: connectScreen(settings.calendars[0].service, origin), page: connectPage(settings.calendars[0].service, origin) }
  : { service: settings.calendars[0].service, screen: connectScreen(settings.calendars[0].service, origin) });

/**
 * The asker's side. `io.members` is the space's members as the asker reads them (each { name, you, person_ref }),
 * asked of the space's rules as see_when_members_are_busy; `io.askBusy(member, { from_ms, to_ms })` asks that member's
 * own store. Answers the free times, and for each member whether their calendar was read. `io.askToConnect(member)`, when
 * given, records an optional connection request for a member without automatic availability (invariant 6). With
 * `include_busy` in the input, a member whose calendar was read also answers their own busy stretches, start and end only. The
 * record result is awaited and returned; delivery and awareness require their own evidence.
 */
export async function findSpaceTimes(input, { members, askBusy, askToConnect = null, spaceTitle, now = () => Date.now(), origin = null }) {
  const search = searchOf(input ?? {}, now());
  if (members.length > limits.most_members) throw new SpaceCalendarError(say('too_many_members', { most: limits.most_members }));
  const answers = await Promise.all(members.map(async member => {
    try { return { member, answer: await askBusy(member, { from_ms: search.fromMs, to_ms: search.toMs }) }; }
    catch (error) { return { member, answer: { shares: true, connected: true, read: false, error: String(error?.message ?? error) } }; }
  }));
  const busy = [];
  const space = spaceTitle ?? 'this space';
  const people = await Promise.all(answers.map(async ({ member, answer }) => {
    const row = { name: member.name, you: member.you === true, shares: answer.shares !== false, connected: answer.shares !== false && answer.connected === true, read: answer.read === true, ...(member.you && answer.account ? { account: answer.account } : {}) };
    if (!row.shares) return { ...row, said: say(member.you ? 'not_shared_you' : 'not_shared_other', { name: member.name }) };
    if (!row.connected) {
      let request;
      if (askToConnect) {
        try { request = await askToConnect(member) ?? { request_recorded: false, state: 'unverified' }; }
        catch (error) { request = { request_recorded: false, state: 'failed', error: String(error?.message ?? error) }; }
      }
      return { ...row, said: say(member.you ? 'not_connected_you' : 'not_connected_other', { name: member.name, space }), connect: connectFor(member, origin), ...(request ? { connection_request: request } : {}) };
    }
    if (!row.read) return { ...row, said: say('unreadable', { name: member.name }) };
    for (const stretch of answer.busy ?? []) busy.push({ start_ms: Date.parse(stretch.start), end_ms: Date.parse(stretch.end) });
    // Asked for them (the Calendar's people), each person's own busy stretches go back with their row: start and end only.
    if (input.include_busy === true) return { ...row, person_ref: member.person_ref, busy: (answer.busy ?? []).slice(0, limits.most_busy_stretches).map(stretch => ({ start: stretch.start, end: stretch.end })) };
    return row;
  }));
  const seen = people.filter(person => person.read);
  const unknown = people.filter(person => !person.read);
  const times = seen.length ? freeTimes({ busy: busy.filter(stretch => Number.isFinite(stretch.start_ms) && Number.isFinite(stretch.end_ms)), ...search, nowMs: now() }) : [];
  const said = !seen.length ? say('nobody_known', { space })
    : !times.length ? say('no_times', { minutes: search.durationMin })
    : unknown.length ? say('some_unknown', { seen: seen.length, total: people.length, space, unknown: unknown.map(person => person.name).join(', ') })
    : say('everyone_free', { space });
  return {
    space_id: input.space_id, from: iso(search.fromMs), to: iso(search.toMs), duration_minutes: search.durationMin, time_zone: search.timeZone,
    everyone_known: unknown.length === 0, times, members: people, said,
  };
}

/**
 * A member's side, in their own store. `io`:
 *   records                the person's record store ({ read(id), write(envelopes, options) }): one record per space
 *                          they chose for (CHOICE_TYPE) and one per meeting placed on their calendar (PLACED_TYPE)
 *   run(tool, input, key)  runs one of this member's Workshop tools: the task, or { connected: false } when the
 *                          connection the tool uses is not connected here
 *   membersAsMe(space_id)  the space's members as this member reads them (each with person_ref)
 *   connected()            the services this member has connected now (their connections list)
 *   openGiven()            the things given to this member in their spaces and not done yet (each with its facts)
 *   give(space_id, item)   places one thing in a space as Trillion ({ kind, title, body, facts }); answers its id,
 *                          or { item_id, delivery }. Keeping it alone establishes no delivery.
 *   origin                 the address this service is reached at, for the connect page
 *   now()                  the time
 */
/**
 * The asker's side of "is anyone I am writing to outside their working hours". `members` are the people named (each
 * { name, you, person_ref }); `askQuiet(member, { at_ms })` asks that member's own store. Answers one row per person other
 * than the asker: { name, person_ref, read, quiet, opens_at_ms, period_start_ms, mode }, with `read: false` and the reason
 * (not shared, hours not set, could not be asked) when it could not be known; unknown is never read as working or as quiet.
 */
export async function findSpaceQuiet({ at_ms: atMs }, { members, askQuiet }) {
  if (!Number.isSafeInteger(atMs)) throw new SpaceCalendarError(say('bad_time'));
  const rows = [];
  for (const member of members.filter(row => !row.you)) {
    try {
      const answer = await askQuiet(member, { at_ms: atMs });
      rows.push(answer?.set === true
        ? { name: member.name, person_ref: member.person_ref, read: true, quiet: answer.quiet === true, opens_at_ms: answer.opens_at_ms ?? null, period_start_ms: answer.period_start_ms ?? null, mode: answer.mode }
        : { name: member.name, person_ref: member.person_ref, read: false, reason: answer?.shares === false ? 'not_shared' : 'not_set' });
    } catch { rows.push({ name: member.name, person_ref: member.person_ref, read: false, reason: 'not_asked' }); }
  }
  return { at_ms: atMs, people: rows };
}

export const CHOICE_TYPE = 'space-calendar-choice';
export const PLACED_TYPE = 'space-calendar-event';
export function memberCalendar({ records, run, workingHours = async () => null, membersAsMe, connected = async () => [], openGiven = async () => [], give = null, origin = '', now = () => Date.now() }) {
  const queue = memberCalendar.queues.get(records) ?? new Map();
  memberCalendar.queues.set(records, queue);
  const keep = (type, key, value) => records.write([{ id: `${type}:${key}`, type, value }], { actor: { by: 'trillion' } });
  const placedOf = eventId => records.read(`${PLACED_TYPE}:${eventId}`) ?? null;
  const calendarById = id => settings.calendars.find(row => row.id === id) ?? null;
  const shares = spaceId => records.read(`${CHOICE_TYPE}:${spaceId}`)?.shares !== false;
  // Which account a calendar's connection is (its row's `account` read), so a person sees they connected the one with
  // their events; null when the row names no such read or it could not be read.
  const accountOf = async calendar => {
    if (!calendar.account?.tool) return null;
    const input = JSON.parse(JSON.stringify(calendar.account.input ?? {}).replaceAll('{now}', iso(now())));
    const task = await run(calendar.account.tool, input, `space-account:${crypto.randomUUID()}`).catch(() => null);
    if (task?.state !== 'completed') return null;
    const name = (calendar.account.path ?? []).reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), task.output);
    return typeof name === 'string' && name ? name : null;
  };
  const inSpace = async spaceId => {
    try { return await membersAsMe(spaceId); }
    catch { throw new SpaceCalendarError(say('not_in_space')); }
  };
  // One meeting's changes run one after another (invariant 4).
  const inTurn = (eventId, work) => {
    const next = (queue.get(eventId) ?? Promise.resolve()).catch(() => {}).then(work);
    queue.set(eventId, next);
    next.finally(() => { if (queue.get(eventId) === next) queue.delete(eventId); }).catch(() => {});
    return next;
  };

  async function place({ space_id: spaceId, space_title: spaceTitle, event }) {
    const at = iso(now());
    const kept = placedOf(event.event_id);
    const startsAt = iso(Date.parse(event.starts_at));
    const endsAt = iso(event.ends_at ? Date.parse(event.ends_at) : Date.parse(event.starts_at) + defaults.event_minutes * MINUTE_MS);
    if (event.going === false) {
      if (!kept || kept.state === 'cancelled') return { placed: false, reason: 'not_going' };
      const calendar = calendarById(kept.calendar);
      const task = await run(calendar.tools.cancel, { calendar_id: calendar.calendar_id, event_id: kept.calendar_event_id }, `space-event:${event.event_id}:cancel:${kept.placed}`);
      if (task.connected === false || task.state !== 'completed') return { placed: true, cancelled: false, error: task.error ?? 'the calendar is not connected' };
      keep(PLACED_TYPE, event.event_id, { ...kept, state: 'cancelled', changed_at: at });
      return { placed: false, cancelled: true };
    }
    if (kept && kept.state === 'placed') {
      if (kept.starts_at === startsAt && kept.ends_at === endsAt) return { placed: true, calendar: kept.calendar, calendar_event_id: kept.calendar_event_id };
      const calendar = calendarById(kept.calendar);
      const move = { calendar_id: calendar.calendar_id, event_id: kept.calendar_event_id, start: startsAt, end: endsAt };
      const task = await run(calendar.tools.move, move, `space-event:${event.event_id}:move:${kept.placed}:${fingerprint(move)}`);
      if (task.connected === false || task.state !== 'completed') return { placed: true, moved: false, error: task.error ?? 'the calendar is not connected' };
      keep(PLACED_TYPE, event.event_id, { ...kept, starts_at: startsAt, ends_at: endsAt, changed_at: at });
      return { placed: true, moved: true, calendar: kept.calendar, calendar_event_id: kept.calendar_event_id };
    }
    if (!shares(spaceId)) return { placed: false, reason: 'not_shared' };
    const placed = (kept?.placed ?? 0) + 1;
    for (const calendar of settings.calendars) {
      const description = [event.about, say('event_from', { space: spaceTitle ?? '' })].filter(Boolean).join('\n\n');
      const create = { calendar_id: calendar.calendar_id, title: event.title, description, start: startsAt, end: endsAt, time_zone: defaults.event_time_zone };
      const task = await run(calendar.tools.create, create, `space-event:${event.event_id}:${calendar.id}:${placed}:${fingerprint(create)}`);
      if (task.connected === false) continue;
      if (task.state !== 'completed') return { placed: false, error: task.error ?? `the calendar answered ${task.state}` };
      const calendarEventId = valueAt(task.output, calendar.reply.event_id);
      if (typeof calendarEventId !== 'string' || !calendarEventId) return { placed: false, error: 'the calendar did not say which event it made' };
      keep(PLACED_TYPE, event.event_id, { event_id: event.event_id, space_id: spaceId, calendar: calendar.id, calendar_event_id: calendarEventId, starts_at: startsAt, ends_at: endsAt, state: 'placed', placed, changed_at: at });
      return { placed: true, calendar: calendar.id, calendar_event_id: calendarEventId };
    }
    return { placed: false, reason: 'not_connected' };
  }

  return {
    shares,
    /** Turns using this member's calendar in one space on or off. */
    async choose({ space_id: spaceId, on, space_title: spaceTitle }) {
      await inSpace(spaceId);
      keep(CHOICE_TYPE, spaceId, { space_id: spaceId, shares: Boolean(on), changed_at: iso(now()) });
      return { space_id: spaceId, on: Boolean(on), said: say(on ? 'choice_on' : 'choice_off', { space: spaceTitle ?? 'this space' }) };
    },
    /** When this member is busy from `from_ms` to `to_ms`, for someone in `space_id` with them (`asker_ref`). */
    async busy({ space_id: spaceId, asker_ref: askerRef, from_ms: fromMs, to_ms: toMs }) {
      const members = await inSpace(spaceId);
      if (!members.some(member => member.person_ref === askerRef)) throw new SpaceCalendarError(say('not_in_space'));
      if (!shares(spaceId)) return { shares: false };
      for (const calendar of settings.calendars) {
        const task = await run(calendar.tools.busy, { calendar_id: calendar.calendar_id, time_min: iso(fromMs), time_max: iso(toMs) }, `space-busy:${spaceId}:${crypto.randomUUID()}`);
        if (task.connected === false) continue;
        if (task.state !== 'completed') return { shares: true, connected: true, read: false, error: task.error ?? `the calendar answered ${task.state}` };
        const { refused, busy } = busyStretches(calendar, task.output);
        const account = members.some(member => member.you && member.person_ref === askerRef) ? await accountOf(calendar) : null;
        if (refused) return { shares: true, connected: true, read: false, error: 'the calendar would not say when it is busy', ...(account ? { account } : {}) };
        return { shares: true, connected: true, read: true, busy: busy.map(stretch => ({ start: iso(stretch.start_ms), end: iso(stretch.end_ms) })), ...(account ? { account } : {}) };
      }
      return { shares: true, connected: false };
    },
    /** Whether this member is outside their working hours at `at_ms`, for someone in `space_id` with them (`asker_ref`). Only
     *  that answer leaves: whether they are quiet, when they next work and the start of this quiet period (so the asker can
     *  remember dismissing a notice for it), never their hours, their zone or what they are doing. It follows the same
     *  per-space choice as busy times. */
    async quiet({ space_id: spaceId, asker_ref: askerRef, at_ms: atMs }) {
      const members = await inSpace(spaceId);
      if (!members.some(member => member.person_ref === askerRef)) throw new SpaceCalendarError(say('not_in_space'));
      if (!shares(spaceId)) return { shares: false };
      const hours = await workingHours();
      if (!hours) return { shares: true, set: false };
      const answer = quietHoursAnswer(hours, atMs, hours.mode);
      return { shares: true, set: true, quiet: answer.quiet, opens_at_ms: answer.opens_at_ms, period_start_ms: answer.period_start_ms, mode: hours.mode };
    },
    /** Places one space meeting on this member's calendar, moves it, or cancels it when they are not going. */
    place: input => inTurn(input.event.event_id, () => place(input)),
    /** Trillion asks this member to connect a calendar, asked by someone in `space_id` with them (invariant 6). */
    askToConnect: input => inTurn('connect-ask', () => askToConnect(input)),
  };

  async function askToConnect({ space_id: spaceId, space_title: spaceTitle, asker_ref: askerRef }) {
    const members = await inSpace(spaceId);
    const me = members.find(member => member.you);
    if (!me || !members.some(member => member.person_ref === askerRef)) throw new SpaceCalendarError(say('not_in_space'));
    if (!shares(spaceId) || !give) return { asked: false, reason: 'not_shared' };
    const have = new Set(await connected());
    if (settings.calendars.some(calendar => have.has(calendar.service))) return { asked: false, reason: 'connected' };
    const calendar = settings.calendars[0];
    const open = (await openGiven()).find(item => item.facts?.connects === calendar.service);
    if (open) return { asked: open.delivery?.delivery_accepted === true, request_created: false, request_recorded: true,
      reason: 'recorded', item_id: open.item_id, delivery: open.delivery ?? { state: 'unverified', delivery_accepted: false, awareness: 'unknown' } };
    const values = { name: me.name, service: calendar.service, service_name: calendar.name ?? calendar.service, space: spaceTitle ?? 'this space' };
    const saved = await give(spaceId, {
      kind: settings.ask.kind, title: fill(settings.ask.title, values),
      body: { text: fill(settings.ask.text, values), link: connectPage(calendar.service, origin) },
      facts: Object.fromEntries(Object.entries(settings.ask.facts).map(([name, value]) => [name, fill(value, values)])),
    });
    const delivery = saved?.delivery ?? { state: 'unverified', delivery_accepted: false, awareness: 'unknown' };
    return { asked: delivery.delivery_accepted === true, request_created: true, request_recorded: true,
      item_id: typeof saved === 'string' ? saved : saved.item_id, delivery };
  }
}
// The waiting changes per store, kept beside the store's records so every call in one store shares them.
memberCalendar.queues = new WeakMap();

/**
 * The space's side, mixed into the Network (src/network.mjs). After a meeting is put on, moved or answered, each
 * member it is for is told in their own store (PersonStore.placeSpaceEvent). In a space joined by invitation a meeting
 * is for every member who has not said they are not going; in a community it is for the members going.
 */
export const spaceEventCalendarMethods = {
  // `cancelled`: the meeting is being taken off, so every member's copy goes (each told going: false).
  eventCalendarNotices(spaceId, eventIds, onlyRelay = null, { cancelled = false } = {}) {
    const space = this.sql.exec('SELECT id, title FROM memberships WHERE id = ?', spaceId).toArray()[0];
    if (!space || !eventIds.length) return [];
    const byRules = this.joinedByRules(spaceId);
    const members = this.sql.exec("SELECT me.relay, r.person_ref FROM members me JOIN relays r ON r.relay = me.relay WHERE me.membership_id = ? AND me.state = 'member'", spaceId).toArray()
      .filter(member => !onlyRelay || member.relay === onlyRelay);
    const notices = [];
    for (const eventId of eventIds) {
      const event = this.sql.exec("SELECT id, title, about, starts_at, ends_at FROM memberships WHERE id = ? AND parent_id = ? AND label = 'event'", eventId, spaceId).toArray()[0];
      if (!event) continue;
      const answered = new Map(this.sql.exec('SELECT relay, state FROM members WHERE membership_id = ?', eventId).toArray().map(row => [row.relay, row.state]));
      for (const member of members) {
        const going = !cancelled && (byRules ? answered.get(member.relay) === 'member' : answered.get(member.relay) !== 'left');
        if (!going && !onlyRelay && !cancelled) continue;
        notices.push({ person_ref: member.person_ref, input: { space_id: spaceId, space_title: space.title, event: { event_id: event.id, title: event.title, about: event.about, starts_at: event.starts_at, ends_at: event.ends_at, going } } });
      }
    }
    return notices;
  },
  // Not awaited by the call that changed the meeting: placing it on calendars never holds up putting it on.
  // The notices are read before anything is sent, so a meeting being cancelled is read while it is still there.
  tellEventCalendars(spaceId, eventIds, onlyRelay = null, { cancelled = false } = {}) {
    if (!this.env?.PERSON) return Promise.resolve([]);
    const notices = this.eventCalendarNotices(spaceId, eventIds, onlyRelay, { cancelled });
    return Promise.allSettled(notices.map(async ({ person_ref: ref, input }) => this.env.PERSON.get(this.env.PERSON.idFromString(ref)).placeSpaceEvent(input)));
  },
  // Everyone in the space is told a meeting moved or was cancelled, as a message in the space from whoever did it
  // (its words are space-calendars.json `changed`), so each member hears of it where they read the space.
  async tellMembersOfMeetingChange({ relay, space_id: spaceId, change, title }) {
    const words = settings.changed?.[change];
    if (!words) return null;
    return this.addSpaceItems({ relay, space_id: spaceId, items: [{ kind: 'message', body: { text: words.replace('{title}', title) } }] }).catch(() => null);
  },
};
