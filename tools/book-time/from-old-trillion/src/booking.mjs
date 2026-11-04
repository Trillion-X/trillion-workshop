// Booking a session that an access is fulfilled by. Which accesses are bookable, with which host, rules, reminders,
// sender and "when may an AI bring it up" condition, is DATA: the trillion package set's bookable-access rows. Open
// times come from calendar-booker's derive-open-slots (the same pure derivation a person's own site's booking uses), minus the
// host's busy calendar when the host has connected one, minus sessions already booked. The host's calendar event is
// made through the host's own calendar connection (the shared Workshop tools the row's `host.calendar.tools` names, run
// in the host's Trillion account), or, with none connected, through the invitation file calendar-booker writes, sent
// with the host as organizer so their calendar shows it.
//
// Nothing here names a host, an offer or a place: every such word is read from a row.
//
// This file holds the parts that run the same anywhere: the rows, the condition reader, open times, the words of
// every message, and `BookingBook`, the record of grants and bookings over any SQLite with Durable Object's
// `exec(...).toArray()` shape. src/booking-calendar.mjs is the Durable Object that owns one host's book; the
// messages and calendar calls go out through `bookingEffects`.
import bookableRecords from '../records/bookable-access-records.json' with { type: 'json' };
import reminderSettings from './booking-reminders.json' with { type: 'json' };
import workspaceSurfaces from './workspace/screens.mjs';
import { addressOf } from './workspace/addresses.mjs';
import { deriveOpenSlots } from '../parts/calendar-booker/do-work/derive-open-slots.ts';
import { calendarInviteFile } from '../parts/calendar-booker/do-work/calendar-invite-file.ts';
import { sendMail } from './mail-sender.mjs';
import { contractAccessRefs, quantityFor } from './contract-entitlements.mjs';
import { offerRows as offerRecords } from './offer-rows.mjs';
import { openRecords } from './record-engine.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const bookables = () => bookableRecords.records.filter(row => row.kind === 'bookable-access');
export const bookableById = id => bookables().find(row => row.id === id) ?? null;
/** The bookable rows an offer's access refs grant, a session it sells or one included with it (`session.included`). */
export const bookablesGranted = (offer, contract = null) => {
  const refs = new Set([...(offer?.access_refs ?? []), ...contractAccessRefs(contract, offer ? [offer] : [])]);
  return bookables().filter(row => refs.has(row.access));
};
/** The sessions an offer sells: its granted rows that are the thing bought, so buying it leads to picking a time. A row
 * included with an offer that sells something else (a free call with a monthly plan) is booked when the person wants. */
export const bookablesInOffer = (offer, contract = null) => bookablesGranted(offer, contract).filter(row => !row.session?.included);
/** The bookable rows a person's current capabilities include. */
export const bookablesHeld = capabilities => bookables().filter(row => (capabilities ?? []).includes(row.access));

/** The workspace address where a person picks a time and pays: the route of the workspace screen that books sessions. */
export const bookingScreenPath = () => addressOf(workspaceSurfaces, workspaceSurfaces.surfaces.find(surface => surface.surface_input?.screen === 'book')?.id);

/** A refusal with the status a caller answers with and words for the person. */
export class BookingRefusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- The condition a row's `mention.when` states, read against a decision record. ----
// A path is a list of keys; an object segment picks the array element whose fields all match it.
export function valueAt(record, path) {
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
export function holds(condition, record) {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition.any)) return condition.any.some(part => holds(part, record));
  if (Array.isArray(condition.all)) return condition.all.length > 0 && condition.all.every(part => holds(part, record));
  const value = valueAt(record, condition.path);
  if ('equals' in condition) return value === condition.equals;
  if ('count_at_least' in condition) return (Array.isArray(value) ? value.length : 0) >= condition.count_at_least;
  return false;
}
// ---- What the person said about a session, and when they were last told of it. ----
// One EEAF setting of the person's (`booking_mentions`): { <bookable id>: { declined_at?, mentioned_at?, case_id? } }.
// An earlier version kept each as an APP_KV key (`booking-mention:<account>:<bookable id>`); `earlier` reads and removes
// those, and each is carried into the setting the first time its bookable is read, then its key removed.
//   setting: { read(), write(value) }   earlier: { get(id) → value | null, remove(id) }

/** What the setting says about each of `ids`, after carrying any earlier key it does not hold yet. */
export async function bookingMentions({ setting, earlier }, ids) {
  const now = setting.read() ?? {};
  const found = {};
  for (const id of ids) if (!Object.hasOwn(now, id)) { const kept = await earlier.get(id); if (kept) found[id] = kept; }
  if (!Object.keys(found).length) return now;
  const merged = { ...now, ...found };
  setting.write(merged);
  for (const id of Object.keys(found)) await earlier.remove(id);
  return merged;
}
/** Adds `fields` to what the setting says about one bookable (carrying its earlier key first); answers the entry. */
export async function keepBookingMention(owner, id, fields) {
  const now = await bookingMentions(owner, [id]);
  const entry = { ...(now[id] ?? {}), ...fields };
  owner.setting.write({ ...now, [id]: entry });
  return entry;
}
/** The earlier APP_KV keys of one account's mentions. */
export const earlierBookingMentions = (kv, userId) => ({
  get: id => kv.get(`booking-mention:${userId}:${id}`, 'json'),
  remove: id => kv.delete(`booking-mention:${userId}:${id}`),
});

/** Whether an AI may bring this bookable session up now: the row's condition holds, the person does not hold it,
 * has not said no, and was not told within the row's quiet days. */
export function mentionFits({ row, record, holdsAccess, seen, nowMs }) {
  if (!row.mention || holdsAccess || seen?.declined_at) return false;
  const quiet = (row.mention.at_most_every_days ?? 0) * DAY_MS;
  if (seen?.mentioned_at && nowMs - Date.parse(seen.mentioned_at) < quiet) return false;
  return holds(row.mention.when, record);
}

// ---- Open times. ----
const dateIn = (ms, timezone) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (dateISO, days) => { const [y, m, d] = dateISO.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };

/** Every open start in the row's horizon: its weekly windows, minus `busy` and `held` intervals (each widened by the
 * row's buffers), minus days that already hold `max_per_day` sessions, from `min_notice_minutes` after now. */
export function openTimes(row, { nowMs, held = [], busy = [] }) {
  const rules = row.rules;
  const perDay = new Map();
  for (const interval of held) perDay.set(dateIn(interval.start_ms, rules.timezone), (perDay.get(dateIn(interval.start_ms, rules.timezone)) ?? 0) + 1);
  const blocked = [...busy, ...held].map(interval => ({ startMs: interval.start_ms, endMs: interval.end_ms }));
  const first = dateIn(nowMs, rules.timezone);
  const times = [];
  for (let day = 0; day < (rules.horizon_days ?? 28); day += 1) {
    const dateISO = addDays(first, day);
    if (rules.max_per_day && (perDay.get(dateISO) ?? 0) >= rules.max_per_day) continue;
    for (const slot of deriveOpenSlots({
      timezone: rules.timezone, windows: rules.windows, dateISO, durationMin: rules.session_minutes, stepMin: rules.step_minutes ?? rules.session_minutes,
      bufferBeforeMin: rules.buffer_before_minutes ?? 0, bufferAfterMin: rules.buffer_after_minutes ?? 0, minNoticeMin: rules.min_notice_minutes ?? 0, nowMs, busy: blocked,
    })) times.push({ start_ms: slot.startMs, end_ms: slot.endMs });
  }
  return times;
}

// ---- Words. ----
/** "Tuesday, 6 October at 9:00 AM" in a timezone, and that zone's short name. */
export function timeWords(ms, timezone) {
  const when = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(part => part.type === 'timeZoneName')?.value ?? timezone;
  return `${when} ${zone}`;
}
export const bookingLink = (origin, token) => `${origin}/book/${token}`;
/** How long a session lasts, in words: "30 minutes", "3 hours". */
export const lengthWords = minutes => (minutes % 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`);
/** The key a purchase's grant is kept under: one per purchase, or one per person for a row that gives each person one
 * session however often they pay for an offer granting it (`session.once_per_person`). */
export const grantKey = (row, effectId, personRef) => (row.session?.once_per_person ? `${row.id}:${personRef}` : effectId);
/** The return-page check and a Stripe webhook for one contract grant one set of sessions. Existing ordinary
 * purchases retain their earlier event-id keys, so reading their booking screen never makes a second grant. */
export const purchaseKey = effect => effect?.material?.contract_id
  ? (effect.kind === 'subscription.renewed' && effect.material.invoice_ref
    ? `invoice:${effect.material.invoice_ref}`
    : effect.material.subscription_id ?? effect.material.payment_intent_ref ?? effect.material.episode_ref ?? effect.material.provider_object_ref ?? effect.effect_id)
  : effect?.effect_id;

/** A grant can be used only in the billing period of the active purchase that made its key. */
export function grantHeldByActivePurchase({ effects = [], episodes = [], grant, row, now_ms: nowMs = Date.now() } = {}) {
  if (!grant || !row || typeof grant.key !== 'string' || !grant.key || (grant.bookable_id && grant.bookable_id !== row.id)) return false;
  if (grant.period_start != null && nowMs < Number(grant.period_start) * 1000) return false;
  if (grant.period_end != null && nowMs >= Number(grant.period_end) * 1000) return false;
  const active = episodes.filter(episode => episode.state === 'active');
  return effects.some(effect => {
    if (!['payment.confirmed', 'subscription.renewed'].includes(effect?.kind) || !effect.effect_id) return false;
    if (grantKey(row, purchaseKey(effect), grant.person_ref) !== grant.key) return false;
    const episode = active.find(item => item.events?.some(event => event.effect_id === effect.effect_id));
    if (!episode || (grant.series_key && grant.series_key !== episode.episode_ref)) return false;
    const offerId = effect.material?.offer_id ?? effect.object;
    const offer = offerRecords.records.find(item => item.id === offerId || item.earlier_ids?.includes(offerId)) ?? null;
    let contract = effect.material?.entitlement_snapshot ?? null;
    if (typeof contract === 'string') {
      try { contract = JSON.parse(contract); } catch { contract = null; }
    }
    if (!bookablesGranted(offer, contract).some(item => item.id === row.id)) return false;
    if (grant.period_start == null) return true;
    const period = bookingPeriod(row, contract, effect);
    return period?.series_key === episode.episode_ref && period.period_start === Number(grant.period_start)
      && (period.period_end == null || nowMs < period.period_end * 1000);
  });
}

function matchesBillingPeriod(per, material, start, end) {
  if (per === 'billing_cycle') return true;
  if (material.billing_interval) return material.billing_interval === per && Number(material.billing_interval_count ?? 1) === 1;
  // Older contracts did not carry their interval in Stripe metadata. Their invoice's actual subscription-line
  // dates still identify one day, week, calendar month or calendar year without using the event arrival time.
  const next = new Date(start * 1000);
  if (per === 'day' || per === 'week') return end - start === (per === 'day' ? 1 : 7) * 86400;
  const day = next.getUTCDate();
  next.setUTCDate(1);
  if (per === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (per === 'year') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else return false;
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next.getTime() === end * 1000;
}

/** A recurring contract's booking allowance follows its paid billing period. A one-time/whole-contract quantity
 * remains attached to the original purchase; once-per-person rows keep their own key. */
export function bookingPeriod(row, contract, effect) {
  const per = quantityFor(contract, row?.access).period;
  if (!['day', 'week', 'month', 'year', 'billing_cycle'].includes(per) || row?.session?.once_per_person) return null;
  const series = effect?.material?.subscription_id ?? effect?.material?.episode_ref ?? effect?.material?.provider_object_ref;
  if (typeof series !== 'string' || !series.startsWith('sub_')) return null;
  if (effect.kind === 'subscription.renewed') {
    const start = Number(effect.material.period_start);
    const end = Number(effect.material.period_end);
    if (effect.material.billing_reason !== 'subscription_cycle' || !effect.material.invoice_ref || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start || !matchesBillingPeriod(per, effect.material, start, end)) return null;
    return { series_key: series, period_start: start, period_end: end };
  }
  if (Number.isSafeInteger(effect.material?.period_start) && Number.isSafeInteger(effect.material?.period_end)
    && matchesBillingPeriod(per, effect.material, effect.material.period_start, effect.material.period_end)) {
    return { series_key: series, period_start: effect.material.period_start, period_end: effect.material.period_end };
  }
  const start = Math.floor(Date.parse(effect.material?.occurred_at ?? '') / 1000);
  return Number.isSafeInteger(start) ? { series_key: series, period_start: start, period_end: null } : null;
}

/** Sessions granted by a negotiated contract, falling back to the bookable row's DATA. */
export function sessionsFor(row, contract = null) {
  const allowance = quantityFor(contract, row?.access);
  return allowance.quantity === null ? (row?.session?.sessions_per_purchase ?? 1) : allowance.quantity;
}
const hostFirstName = row => row.host.name;

// A video-call session's join link, as lines of a message; nothing for any other session.
const callLines = booking => (booking.video_link ? [`Join the video call: ${booking.video_link}`, ''] : []);
/** Every message this flow sends, as { to, subject, text, invite? }: words only, from the row and the booking. */
export const messages = {
  bought: ({ row, grant, origin, offer }) => [
    {
      to: grant.email ? [grant.email] : [], subject: `Book your time with ${hostFirstName(row)}`,
      text: [
        `Thank you for buying ${offer?.label ?? row.session.title}.`, '',
        `Pick the time that suits you here:`, bookingLink(origin, grant.token), '',
        `${row.session.place}`, '',
        `Your account shows the same booking: sign in at ${origin}/account with your passkey and open your decisions.`,
        `Reply to this email to reach ${hostFirstName(row)}.`,
      ].join('\n'),
    },
    {
      to: [row.host.email], subject: `New booking to schedule: ${grant.customer_name ?? grant.email ?? 'A customer'} bought ${offer?.label ?? row.session.title}`,
      text: [`${grant.customer_name ?? grant.email ?? 'A customer'} bought ${offer?.label ?? row.session.title}${offer?.price_options?.[0]?.label ? ` (${offer.price_options[0].label})` : ''}.`, '', `They can pick a time in their account; you will get the calendar invite when they do.`].join('\n'),
    },
  ],
  booked: ({ row, booking, origin, placed }) => {
    const when = timeWords(booking.start_ms, row.rules.timezone);
    const invite = placed.route === 'invite' ? placed.invite : null;
    return [
      {
        to: booking.email ? [booking.email] : [], subject: `You're booked with ${hostFirstName(row)}: ${when}`,
        text: [
          `You're booked with ${hostFirstName(row)} on ${when}, for ${lengthWords(row.rules.session_minutes)}.`, '',
          row.session.place, '', ...callLines(booking),
          placed.route === 'calendar' ? 'A calendar invitation is on its way from Google Calendar.' : 'The calendar invitation is attached.', '',
          `Change or cancel: ${bookingLink(origin, booking.token)}`,
        ].join('\n'),
        invite,
      },
      {
        to: [row.host.email], subject: `Booked: ${booking.customer_name ?? booking.email ?? 'A customer'}, ${when}`,
        text: [
          `${booking.customer_name ?? booking.email ?? 'A customer'} booked ${row.session.title} on ${when}.`,
          booking.case_id ? `\nThe decision it is about is saved in their account (${booking.case_id}).` : '',
          '', ...callLines(booking), placed.route === 'calendar' ? 'It is on your calendar with them invited.' : 'The invitation is attached; open it to add it to your calendar.',
        ].join('\n'),
        invite,
      },
    ];
  },
  moved: ({ row, booking, origin, placed }) => {
    const when = timeWords(booking.start_ms, row.rules.timezone);
    const invite = placed.route === 'invite' ? placed.invite : null;
    return [
      { to: booking.email ? [booking.email] : [], subject: `New time with ${hostFirstName(row)}: ${when}`, text: [`Your session with ${hostFirstName(row)} is now ${when}.`, '', ...callLines(booking), `Change or cancel: ${bookingLink(origin, booking.token)}`].join('\n'), invite },
      { to: [row.host.email], subject: `Moved: ${booking.customer_name ?? booking.email ?? 'A customer'}, now ${when}`, text: `${booking.customer_name ?? booking.email ?? 'A customer'} moved their session to ${when}.`, invite },
    ];
  },
  cancelled: ({ row, booking, origin, placed }) => {
    const when = timeWords(booking.start_ms, row.rules.timezone);
    const invite = placed.route === 'invite' ? placed.invite : null;
    return [
      { to: booking.email ? [booking.email] : [], subject: `Cancelled: your session with ${hostFirstName(row)} on ${when}`, text: [`Your session on ${when} is cancelled.`, '', `Pick another time: ${bookingLink(origin, booking.grant_token)}`].join('\n'), invite },
      { to: [row.host.email], subject: `Cancelled: ${booking.customer_name ?? booking.email ?? 'A customer'}, ${when}`, text: `${booking.customer_name ?? booking.email ?? 'A customer'} cancelled their session on ${when}. The time is open again.`, invite },
    ];
  },
  reminder: ({ row, booking, origin }) => {
    const when = timeWords(booking.start_ms, row.rules.timezone);
    return [
      { to: booking.email ? [booking.email] : [], subject: `Reminder: your session with ${hostFirstName(row)}, ${when}`, text: [`Your session with ${hostFirstName(row)} is on ${when}.`, '', row.session.place, '', ...callLines(booking), `Change or cancel: ${bookingLink(origin, booking.token)}`].join('\n') },
      { to: [row.host.email], subject: `Reminder: ${booking.customer_name ?? booking.email ?? 'A customer'}, ${when}`, text: [`Your session with ${booking.customer_name ?? booking.email ?? 'a customer'} is on ${when}.`, '', ...callLines(booking)].join('\n').trim() },
    ];
  },
};

/** The invitation file for a booking, with the host as organizer and the buyer invited. */
export function inviteFor(row, booking, { method = 'REQUEST', nowMs }) {
  return calendarInviteFile({
    uid: `${booking.id}@trillion`, start_ms: booking.start_ms, end_ms: booking.end_ms,
    summary: `${row.session.title}: ${booking.customer_name ?? booking.email ?? 'A customer'}`, description: row.session.place, location: row.session.place,
    organizer: { name: row.host.name, email: row.host.email }, attendees: booking.email ? [{ email: booking.email }] : [],
    method, sequence: booking.sequence ?? 0, now_ms: nowMs, reminder_minutes: (row.reminders ?? []).map(item => item.minutes_before),
  });
}

// ---- The record of grants and bookings. ----
// Grants and bookings are records (kinds booking-grant and booking, src/record-model.json) in the host's booking
// calendar's own record log. Nothing in a record says who it is for: a grant's key, each link's token, and the person,
// their email and their name are rows of booking_parties beside the log, so forgetting a person erases them for good
// (the log keeps every earlier value of a record). Reminders are the send schedule of the booked sessions and holds the
// times kept while someone pays: both stay rows of their own. A calendar kept before this holds grants and bookings as
// tables; the first open moves them in and drops the tables.
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const ACTOR = { actor: { by: 'booking-calendar' } };
const GRANT_FIELDS = ['bookable_id', 'offer_id', 'sessions', 'created_at', 'series_key', 'period_start', 'period_end', 'buyer_notified_at', 'host_notified_at'];
const BOOKING_FIELDS = ['grant', 'bookable_id', 'start_ms', 'end_ms', 'state', 'case_id', 'event_id', 'route', 'video_link', 'sequence', 'created_at', 'updated_at'];
const pick = (row, fields) => Object.fromEntries(fields.map(name => [name, row[name] ?? null]));
const MOVED_PER_WRITE = 50;
const bookingKey = id => `booking:${id}`;

export class BookingBook {
  constructor(sql, { now = () => Date.now(), token = randomToken, transaction = fn => fn() } = {}) {
    this.sql = sql;
    this.now = now;
    this.token = token;
    this.transaction = transaction;
    this.records = openRecords(sql, { transaction });
    sql.exec('CREATE TABLE IF NOT EXISTS booking_parties (record_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT UNIQUE, token TEXT UNIQUE NOT NULL, person_ref TEXT, email TEXT, customer_name TEXT)');
    sql.exec('CREATE INDEX IF NOT EXISTS booking_parties_person ON booking_parties (person_ref, kind)');
    sql.exec(`CREATE TABLE IF NOT EXISTS reminders (booking_id TEXT NOT NULL, minutes_before INTEGER NOT NULL, due_ms INTEGER NOT NULL, sent_at TEXT, PRIMARY KEY (booking_id, minutes_before))`);
    // The people a reminder's mail already reached (JSON array of addresses) and its tries so far; a book kept before them gets the columns.
    if (!sql.exec('PRAGMA table_info(reminders)').toArray().some(column => column.name === 'sent_to')) sql.exec('ALTER TABLE reminders ADD COLUMN sent_to TEXT');
    if (!sql.exec('PRAGMA table_info(reminders)').toArray().some(column => column.name === 'tries')) sql.exec('ALTER TABLE reminders ADD COLUMN tries INTEGER NOT NULL DEFAULT 0');
    // A time a person picked before paying: kept from everyone else until `until_ms`, one per person and bookable.
    sql.exec(`CREATE TABLE IF NOT EXISTS holds (bookable_id TEXT NOT NULL, person_ref TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, until_ms INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (bookable_id, person_ref))`);
    this.moveTables();
  }
  rows(query, ...binds) { return this.sql.exec(query, ...binds).toArray(); }
  at() { return new Date(this.now()).toISOString(); }

  // The grants and bookings tables of a calendar kept before they were records: every row becomes a record and its
  // booking_parties row, a page per write, and each table is dropped once moved, all in one transaction.
  moveTables() {
    const present = name => this.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
    if (!present('grants') && !present('bookings')) return;
    this.transaction(() => {
      const write = records => { for (let at = 0; at < records.length; at += MOVED_PER_WRITE) this.records.write(records.slice(at, at + MOVED_PER_WRITE), ACTOR); };
      const party = (recordId, kind, key, row) => this.sql.exec('INSERT INTO booking_parties (record_id, kind, key, token, person_ref, email, customer_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        recordId, kind, key, row.token, row.person_ref ?? null, row.email ?? null, row.customer_name ?? null);
      const grantIds = new Map();
      if (present('grants')) {
        const moved = this.rows('SELECT * FROM grants').map(row => {
          const id = `booking-grant:${crypto.randomUUID()}`;
          grantIds.set(row.key, id);
          party(id, 'grant', row.key, row);
          return { id, type: 'booking-grant', value: pick(row, GRANT_FIELDS) };
        });
        write(moved);
        this.sql.exec('DROP TABLE grants');
      }
      if (present('bookings')) {
        const moved = this.rows('SELECT * FROM bookings').map(row => {
          party(bookingKey(row.id), 'booking', null, row);
          return { id: bookingKey(row.id), type: 'booking', value: pick({ ...row, grant: grantIds.get(row.grant_key) ?? this.partyByKey(row.grant_key)?.record_id ?? null }, BOOKING_FIELDS) };
        });
        write(moved);
        this.sql.exec('DROP TABLE bookings');
      }
    });
  }

  partyOf(recordId) { return this.rows('SELECT * FROM booking_parties WHERE record_id = ? LIMIT 1', recordId)[0] ?? null; }
  partyByKey(key) { return this.rows("SELECT * FROM booking_parties WHERE key = ? AND kind = 'grant' LIMIT 1", key)[0] ?? null; }
  // A grant as its callers know it: its record, and its key, token and person from booking_parties.
  grantRow(party) {
    const value = party && this.records.read(party.record_id);
    return value ? { ...value, record_id: party.record_id, key: party.key, token: party.token, person_ref: party.person_ref, email: party.email, customer_name: party.customer_name } : null;
  }
  // A booking as its callers know it: its record, the key of the grant it is under, and its token and person.
  bookingRow(party) {
    const value = party && this.records.read(party.record_id);
    if (!value) return null;
    return { ...value, id: party.record_id.slice(bookingKey('').length), grant_key: value.grant ? this.partyOf(value.grant)?.key ?? null : null,
      token: party.token, person_ref: party.person_ref, email: party.email, customer_name: party.customer_name };
  }
  grantByKey(key) { return this.grantRow(this.partyByKey(key)); }
  bookingById(id) { return this.bookingRow(this.partyOf(bookingKey(id))); }
  changeGrant(grant, fields) { this.records.write([{ id: grant.record_id, type: 'booking-grant', value: { ...pick(this.records.read(grant.record_id) ?? grant, GRANT_FIELDS), ...fields } }], ACTOR); }
  changeBooking(booking, fields) { this.records.write([{ id: bookingKey(booking.id), type: 'booking', value: { ...pick(this.records.read(bookingKey(booking.id)) ?? booking, BOOKING_FIELDS), ...fields } }], ACTOR); }
  // A person's grants or bookings (person_ref null: those with no person), each as its callers know it.
  // reads-ok: one person's grants or bookings with one host, the same rows the grants and bookings tables answered per person before
  partiesOf(personRef, kind) { return this.rows('SELECT * FROM booking_parties WHERE person_ref IS ? AND kind = ?', personRef, kind); }
  grantsOf(personRef) { return this.partiesOf(personRef, 'grant').map(party => this.grantRow(party)).filter(Boolean); }

  /** One grant per purchase, bookable access and person. Keep earlier keys for their original buyer. */
  grant({ key, bookable_id, person_ref = null, email = null, name = null, offer_id = null, contract = null, period = null }) {
    return this.transaction(() => {
      // A public contract link can give the same purchase episode to several signers. The first signer may already
      // have a grant under that bare episode key, so keep it; later signers use a key scoped to their identity and
      // this bookable access. Always look for the scoped key first, even if the earlier buyer was later forgotten.
      const scopedKey = JSON.stringify(['booking-grant', key, bookable_id, person_ref]);
      const scoped = this.grantByKey(scopedKey);
      const bare = this.grantByKey(key);
      if (scoped && (scoped.person_ref !== person_ref || scoped.bookable_id !== bookable_id)) throw new Error('A booking grant belongs to someone else.');
      const existing = scoped ?? (bare?.person_ref === person_ref && bare?.bookable_id === bookable_id ? bare : null);
      key = existing?.key ?? (bare ? scopedKey : key);
      if (existing) {
        if ((email && !existing.email) || (name && !existing.customer_name)) this.sql.exec("UPDATE booking_parties SET email = COALESCE(email, ?), customer_name = COALESCE(customer_name, ?) WHERE key = ? AND kind = 'grant'", email, name, key);
        // Grants made before period tracking already use the subscription ID as their key. Attach the period on replay
        // so a later cycle closes their unused balance without replacing their booked sessions or link.
        if (period && !existing.series_key && key === period.series_key && existing.bookable_id === bookable_id) this.changeGrant(existing, { series_key: period.series_key, period_start: period.period_start });
        return { grant: this.grantByKey(key), created: false };
      }
      const row = bookableById(bookable_id);
      if (!row) throw new BookingRefusal(404, 'This session is not offered.');
      const series = () => this.grantsOf(person_ref).filter(grant => grant.bookable_id === bookable_id && grant.series_key === period.series_key);
      if (period) {
        const legacy = this.grantByKey(period.series_key);
        if (legacy && legacy.bookable_id === bookable_id && legacy.person_ref === person_ref && legacy.series_key == null) {
          const began = Math.floor(Date.parse(legacy.created_at) / 1000);
          if (Number.isSafeInteger(began)) this.changeGrant(legacy, { series_key: period.series_key, period_start: began });
        }
        const same = series().find(grant => grant.period_start === period.period_start);
        if (same) return { grant: same, created: false };
      }
      const following = period ? series().filter(grant => grant.period_start > period.period_start).sort((a, b) => a.period_start - b.period_start)[0] ?? null : null;
      const end = following ? Math.min(period.period_end ?? following.period_start, following.period_start) : period?.period_end ?? null;
      const id = `booking-grant:${crypto.randomUUID()}`;
      this.sql.exec("INSERT INTO booking_parties (record_id, kind, key, token, person_ref, email, customer_name) VALUES (?, 'grant', ?, ?, ?, ?, ?)", id, key, this.token(), person_ref, email, name);
      this.records.write([{ id, type: 'booking-grant', value: pick({ bookable_id, offer_id, sessions: sessionsFor(row, contract), created_at: this.at(),
        series_key: period?.series_key ?? null, period_start: period?.period_start ?? null, period_end: end }, GRANT_FIELDS) }], ACTOR);
      if (period) {
        for (const earlier of series()) {
          if (earlier.record_id !== id && earlier.period_start < period.period_start && (earlier.period_end == null || earlier.period_end > period.period_start)) this.changeGrant(earlier, { period_end: period.period_start });
        }
      }
      return { grant: this.grantByKey(key), created: true };
    });
  }
  grantByToken(token) { return typeof token === 'string' && token ? this.grantRow(this.rows("SELECT * FROM booking_parties WHERE token = ? AND kind = 'grant' LIMIT 1", token)[0]) : null; }
  notified(grantKey, who) {
    if (!['buyer', 'host'].includes(who)) throw new TypeError('Unknown purchase notice recipient.');
    const grant = this.grantByKey(grantKey);
    if (grant) this.changeGrant(grant, { [`${who}_notified_at`]: this.at() });
  }
  grantsFor(personRef) { return this.grantsOf(personRef).sort((a, b) => a.created_at.localeCompare(b.created_at)); }
  bookingByToken(token) { return typeof token === 'string' && token ? this.bookingRow(this.rows("SELECT * FROM booking_parties WHERE token = ? AND kind = 'booking' LIMIT 1", token)[0]) : null; }
  booked(list) { return list.filter(booking => booking?.state === 'booked').sort((a, b) => a.start_ms - b.start_ms); }
  bookingsOf(grantKey) {
    const grant = this.partyByKey(grantKey);
    return grant ? this.booked(this.records.scan('booking', 'grant', { equal: [grant.record_id] }).map(entry => this.bookingRow(this.partyOf(entry.id)))) : [];
  }
  bookingsFor(personRef) { return this.booked(this.partiesOf(personRef, 'booking').map(party => this.bookingRow(party))); }
  /** The sessions booked on a bookable that end after `sinceMs`, earliest first. A session is shorter than a day, so
   * those that start a day before it are the only ones read. */
  bookedOn(bookableId, sinceMs) {
    return this.booked(this.records.scan('booking', 'bookable', { equal: [bookableId], from: sinceMs - DAY_MS }).map(entry => this.bookingRow(this.partyOf(entry.id))))
      .filter(booking => booking.end_ms > sinceMs);
  }
  /** Sessions this grant can still book. */
  left(grant) {
    // Read the current grant: a later invoice may have shortened it after an earlier state read.
    const current = this.grantByKey(grant.key) ?? grant;
    if ((current.period_start != null && this.now() < current.period_start * 1000) || (current.period_end != null && this.now() >= current.period_end * 1000)) return 0;
    return Math.max(0, current.sessions - this.bookingsOf(current.key).length);
  }
  /** The booked intervals on a bookable, and every time someone is paying for now, optionally leaving out one booking
   * (the one being moved) and one person's own hold (the person booking it). */
  held(bookableId, except = null, holder = null) {
    const booked = this.bookedOn(bookableId, this.now() - DAY_MS).filter(item => item.id !== except);
    const paying = this.rows('SELECT person_ref, start_ms, end_ms FROM holds WHERE bookable_id = ? AND until_ms > ?', bookableId, this.now())
      .filter(item => item.person_ref !== holder);
    return [...booked, ...paying].map(({ start_ms, end_ms }) => ({ start_ms, end_ms }));
  }
  /** Whether `startMs` is one of the open times right now, given the host's busy intervals. */
  isOpen(row, startMs, busy, except = null, holder = null) {
    return openTimes(row, { nowMs: this.now(), held: this.held(row.id, except, holder), busy }).find(time => time.start_ms === startMs) ?? null;
  }
  /** Keeps `time` for one person while they pay, for the row's `rules.hold_minutes`; their earlier pick is let go. */
  hold(row, personRef, time) {
    this.sql.exec('INSERT OR REPLACE INTO holds (bookable_id, person_ref, start_ms, end_ms, until_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      row.id, personRef, time.start_ms, time.end_ms, this.now() + (row.rules.hold_minutes ?? 0) * MINUTE_MS, this.at());
    return this.holdOf(row.id, personRef);
  }
  /** The time a person last picked for a bookable, kept or already let go (`until_ms` says which), or null. */
  holdOf(bookableId, personRef) { return this.rows('SELECT * FROM holds WHERE bookable_id = ? AND person_ref = ?', bookableId, personRef)[0] ?? null; }
  letGo(bookableId, personRef) { this.sql.exec('DELETE FROM holds WHERE bookable_id = ? AND person_ref = ?', bookableId, personRef); }

  /** Books a time under a grant. The time must be open at this moment; the grant must have a session left. */
  book({ grant, start_ms: startMs, busy = [], case_id: caseId = null }) {
    const row = bookableById(grant.bookable_id);
    this.hasLeft(grant);
    const time = this.isOpen(row, Number(startMs), busy, null, grant.person_ref);
    if (!time) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another from the open times.');
    return this.record({ grant, time, case_id: caseId });
  }
  hasLeft(grant) {
    if (!this.left(grant)) throw new BookingRefusal(409, 'Your session is already booked. Change or cancel it from its link to pick another time.');
  }
  /** Keeps a booking at `time` under a grant: a time `book` found open, or one the host's calendar service already
   * booked (`event_id` is that service's reference for it, `route` how it reached the host's calendar). */
  record({ grant, time, case_id: caseId = null, event_id: eventId = null, route = null, video_link: videoLink = null }) {
    const row = bookableById(grant.bookable_id);
    this.hasLeft(grant);
    const id = `booking_${this.token().slice(0, 20)}`;
    const at = this.at();
    const party = this.partyByKey(grant.key);
    this.transaction(() => {
      this.sql.exec("INSERT INTO booking_parties (record_id, kind, key, token, person_ref, email, customer_name) VALUES (?, 'booking', NULL, ?, ?, ?, ?)",
        bookingKey(id), this.token(), party?.person_ref ?? grant.person_ref ?? null, party?.email ?? grant.email ?? null, party?.customer_name ?? grant.customer_name ?? null);
      this.records.write([{ id: bookingKey(id), type: 'booking', value: pick({ grant: party?.record_id ?? null, bookable_id: row.id, start_ms: time.start_ms, end_ms: time.end_ms, state: 'booked',
        case_id: caseId, event_id: eventId, route, video_link: videoLink, sequence: 0, created_at: at, updated_at: at }, BOOKING_FIELDS) }], ACTOR);
      this.remind(id, row, time.start_ms);
    });
    return this.bookingById(id);
  }
  /** Moves a booking to another open time. */
  move(booking, startMs, busy = []) {
    const row = bookableById(booking.bookable_id);
    this.changeable(row, booking);
    const time = this.isOpen(row, Number(startMs), busy, booking.id);
    if (!time) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another from the open times.');
    return this.moveTo(booking, time);
  }
  /** Puts a booking at `time` (and, when its calendar service gave the moved booking a new reference and call link,
   * `event_id` and `video_link`). */
  moveTo(booking, time, eventId = booking.event_id, videoLink = booking.video_link ?? null) {
    const row = bookableById(booking.bookable_id);
    this.transaction(() => {
      const current = this.bookingById(booking.id) ?? booking;
      this.changeBooking(booking, { start_ms: time.start_ms, end_ms: time.end_ms, event_id: eventId, video_link: videoLink, sequence: (current.sequence ?? 0) + 1, updated_at: this.at() });
      this.sql.exec('DELETE FROM reminders WHERE booking_id = ?', booking.id);
      this.remind(booking.id, row, time.start_ms);
    });
    return this.bookingById(booking.id);
  }
  /** Cancels a booking; its time opens again and its session can be booked again. */
  cancel(booking) {
    this.changeable(bookableById(booking.bookable_id), booking);
    return this.close(booking);
  }
  /** Marks a booking cancelled, as its host's calendar already says it is. */
  close(booking) {
    this.transaction(() => {
      const current = this.bookingById(booking.id) ?? booking;
      this.changeBooking(booking, { state: 'cancelled', sequence: (current.sequence ?? 0) + 1, updated_at: this.at() });
      this.sql.exec('DELETE FROM reminders WHERE booking_id = ?', booking.id);
    });
    return this.bookingById(booking.id);
  }
  changeable(row, booking) {
    if (booking.state !== 'booked') throw new BookingRefusal(409, 'This session is already cancelled.');
    const until = (row.rules.cancel_until_minutes_before ?? 0) * MINUTE_MS;
    if (booking.start_ms - this.now() < until) throw new BookingRefusal(409, `This session starts too soon to change here. Contact ${row.host.name} to change it.`);
  }
  placed(bookingId, { event_id: eventId = null, route, video_link: videoLink = null }) {
    const booking = this.bookingById(bookingId);
    if (booking) this.changeBooking(booking, { event_id: eventId, route, video_link: videoLink ?? booking.video_link ?? null, updated_at: this.at() });
  }
  remind(bookingId, row, startMs) {
    for (const { minutes_before: before } of row.reminders ?? []) {
      const due = startMs - before * MINUTE_MS;
      if (due > this.now()) this.sql.exec('INSERT OR REPLACE INTO reminders (booking_id, minutes_before, due_ms, sent_at) VALUES (?, ?, ?, NULL)', bookingId, before, due);
    }
  }
  // A session that has started gets no reminder, not even a retry. The earliest due, a page per wake; the alarm wakes
  // again at once for any left (nextReminderAt).
  dueReminders(most = reminderSettings.most_per_wake) {
    const due = [];
    // A page at a time after the last reminder read, skipping those whose session was cancelled or has started.
    let last = [-1, '', -1];
    while (due.length < most) {
      const page = this.rows('SELECT booking_id, minutes_before, sent_to, tries, due_ms FROM reminders WHERE sent_at IS NULL AND due_ms <= ? AND (due_ms, booking_id, minutes_before) > (?, ?, ?) ORDER BY due_ms, booking_id, minutes_before LIMIT ?',
        this.now(), ...last, most);
      for (const { due_ms: dueMs, ...reminder } of page) {
        const booking = this.bookingById(reminder.booking_id);
        if (booking?.state === 'booked' && booking.start_ms > this.now()) due.push({ ...booking, ...reminder });
        last = [dueMs, reminder.booking_id, reminder.minutes_before];
      }
      if (page.length < most) break;
    }
    return due.slice(0, most);
  }
  reminded(bookingId, minutesBefore) { this.sql.exec('UPDATE reminders SET sent_at = ? WHERE booking_id = ? AND minutes_before = ?', this.at(), bookingId, minutesBefore); }
  /** A reminder some of whose mail was refused: who it reached, its tries, and when it is due again. */
  retried(bookingId, minutesBefore, { sentTo, tries, dueMs }) { this.sql.exec('UPDATE reminders SET sent_to = ?, tries = ?, due_ms = ? WHERE booking_id = ? AND minutes_before = ?', JSON.stringify(sentTo), tries, dueMs, bookingId, minutesBefore); }
  nextReminderAt() { return this.rows('SELECT MIN(due_ms) AS due FROM reminders WHERE sent_at IS NULL')[0]?.due ?? null; }
  /** A person who deletes their account: their upcoming sessions are returned for cancelling, and their email is forgotten. */
  forget(personRef) {
    const upcoming = this.bookingsFor(personRef).filter(booking => booking.start_ms > this.now());
    this.transaction(() => {
      this.sql.exec("UPDATE booking_parties SET email = NULL, customer_name = NULL, person_ref = NULL WHERE person_ref = ? AND kind = 'grant'", personRef);
      for (const party of this.partiesOf(personRef, 'booking')) {
        if (this.records.read(party.record_id)?.state !== 'booked') this.sql.exec('UPDATE booking_parties SET email = NULL, customer_name = NULL, person_ref = NULL WHERE record_id = ?', party.record_id);
      }
      this.sql.exec('DELETE FROM holds WHERE person_ref = ?', personRef);
    });
    return upcoming;
  }
}

// ---- Messages and calendar calls going out. ----
// Mail goes through the email-sending binding the row names. The host's calendar is the host's own connection, reached
// through the shared tools the row's `host.calendar` names, run in the host's Trillion account by `runFor(account)`
// (src/booking-service.mjs hostToolRunner): `{ connected: false }` when the host has not connected it, else the task.
// Every tool gets the row's `calendar_id`; `reply` says where each reply keeps what is read. Code carries only names.
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const joinAddress = value => (typeof value === 'string' && /^https:\/\/\S+$/.test(value) ? value : null);

// The host's calendar for a row: `call(verb, input)` → { connected: false } | { connected: true, output } | { connected: true, error }.
function hostCalendar(row, runFor) {
  const spec = row.host.calendar;
  if (!object(spec?.tools)) return null;
  const run = runFor(spec.account);
  return async (verb, input) => {
    if (!spec.tools[verb]) return { connected: false };
    const task = await run(spec.tools[verb], { calendar_id: spec.calendar_id, ...input });
    if (task.connected === false) return { connected: false };
    if (task.state !== 'completed') return { connected: true, error: task.error ?? `the ${verb} call ${task.state ?? 'did not finish'}` };
    return { connected: true, output: task.output };
  };
}

// Every busy stretch in the busy reply (objects carrying the row's start field), and whether the calendar said it
// could not be read.
export function busyStretches(spec, output) {
  const fields = spec.reply?.fields ?? {};
  const found = [];
  let refused = false;
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (object(value)) {
      if (fields.errors && Array.isArray(value[fields.errors]) && value[fields.errors].length) refused = true;
      if (typeof value[fields.start] === 'string') found.push({ start_ms: Date.parse(value[fields.start]), end_ms: Date.parse(value[fields.end]) });
      else Object.values(value).forEach(walk);
    }
  };
  walk(valueAt(output, spec.reply?.busy));
  return { refused, busy: found.filter(block => Number.isFinite(block.start_ms) && Number.isFinite(block.end_ms)) };
}

export function bookingEffects(env, { runFor = () => async () => ({ connected: false }) } = {}) {
  const base64 = text => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const iso = ms => new Date(ms).toISOString();
  const madeEvent = (row, output) => ({
    event_id: valueAt(output, row.host.calendar.reply?.event_id) ?? null,
    video_link: (row.host.calendar.reply?.video_link ?? []).map(path => joinAddress(valueAt(output, path))).find(Boolean) ?? null,
  });
  return {
    /** Sends one message from Trillion's one sender (src/mail-sender.mjs), replies going to the host; returns { sent, id } or { sent: false, error }. */
    async mail(row, { to, subject, text, invite = null }) {
      return sendMail(env, { reply_to: row.host.email }, { to, subject, text,
        attachments: invite ? [{ filename: 'invite.ics', content: base64(invite), type: 'text/calendar; method=REQUEST; charset=UTF-8', disposition: 'attachment' }] : null });
    },
    /** The host's busy intervals: `read`, `unknown` when the host has connected no calendar, or `unreadable`. */
    async busy(row, fromMs, toMs) {
      const call = hostCalendar(row, runFor);
      const read = call ? await call('busy', { time_min: iso(fromMs), time_max: iso(toMs) }) : { connected: false };
      if (!read.connected) return { status: 'unknown', busy: [] };
      if (read.error) return { status: 'unreadable', busy: [], error: read.error };
      const { refused, busy } = busyStretches(row.host.calendar, read.output);
      return refused ? { status: 'unreadable', busy: [], error: 'the calendar would not say when it is busy' } : { status: 'read', busy };
    },
    /** Puts a booking on the host's calendar: by the host's calendar connection when connected, else by invitation
     * file. A row whose sessions are video calls (`session.video_call`) has the call made with the event; the invitation
     * file cannot make one, so such a row is placed only on the calendar ({ route: null, error } otherwise, and nothing
     * is left there). */
    async place(row, booking, nowMs) {
      const call = hostCalendar(row, runFor);
      const made = call ? await call('create', {
        title: `${row.session.title}: ${booking.customer_name ?? booking.email ?? 'A customer'}`, description: row.session.place, location: row.session.place,
        start: iso(booking.start_ms), end: iso(booking.end_ms), time_zone: row.rules.timezone, ...(booking.email ? { attendee_email: booking.email } : {}),
        ...(row.session.video_call ? { request_id: booking.id } : {}),
      }) : { connected: false };
      if (made.connected && !made.error) {
        const event = madeEvent(row, made.output);
        if (event.event_id && (!row.session.video_call || event.video_link)) return { route: 'calendar', event_id: event.event_id, iso: iso(booking.start_ms).slice(0, 19), ...(event.video_link ? { video_link: event.video_link } : {}) };
        if (row.session.video_call && event.event_id) await call('cancel', { event_id: event.event_id });
      }
      if (row.session.video_call) return { route: null, event_id: null, connected: Boolean(made.connected), error: made.connected ? 'the calendar did not make the video call' : 'no calendar is connected' };
      return { route: 'invite', event_id: null, invite: inviteFor(row, booking, { nowMs }) };
    },
    async move(row, booking, nowMs) {
      const call = hostCalendar(row, runFor);
      if (call && booking.route === 'calendar' && booking.event_id) {
        const moved = await call('move', { event_id: booking.event_id, start: iso(booking.start_ms), end: iso(booking.end_ms) });
        if (moved.connected && !moved.error) return { route: 'calendar', event_id: booking.event_id };
      }
      return { route: 'invite', event_id: null, invite: inviteFor(row, booking, { nowMs }) };
    },
    async cancel(row, booking, nowMs) {
      const call = hostCalendar(row, runFor);
      if (call && booking.route === 'calendar' && booking.event_id) {
        const cancelled = await call('cancel', { event_id: booking.event_id });
        if (cancelled.connected && !cancelled.error) return { route: 'calendar', event_id: booking.event_id };
      }
      return { route: 'invite', event_id: null, invite: inviteFor(row, booking, { method: 'CANCEL', nowMs }) };
    },
  };
}

// How a booking reached the host's calendar, in words: by the calendar connection, by invitation file, or booked on
// the host's own calendar service (src/booking-service.mjs).
const HOST_CALENDAR_WORDS = { calendar: 'calendar event', invite: 'invitation sent', service: "booked on the host's calendar" };
/** What a person sees of one booking: never another person's email, never a grant's key. */
export const bookingView = (row, booking, origin) => ({
  booking_id: booking.id, title: row.session.title, host: row.host.name, place: row.session.place,
  starts_at: new Date(booking.start_ms).toISOString(), ends_at: new Date(booking.end_ms).toISOString(), when: timeWords(booking.start_ms, row.rules.timezone), booked_at: booking.created_at,
  on_host_calendar: HOST_CALENDAR_WORDS[booking.route] ?? 'being added',
  buyer_has_email: Boolean(booking.email),
  ...(booking.video_link ? { video_link: booking.video_link } : {}),
  change_or_cancel: bookingLink(origin, booking.token),
});
export const timeView = (row, time) => ({ start: new Date(time.start_ms).toISOString(), when: timeWords(time.start_ms, row.rules.timezone) });
