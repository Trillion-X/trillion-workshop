// src/hold-to-it.mjs
//
// Purpose
//   Holds a group to what it agreed. An agreement found in any transcript, message or meeting ("we need to have a
//   meeting every day", and everyone said yes) is kept in the group's space as an item every member reads. For an
//   agreement with a time, Trillion keeps its next meeting on the space's calendar, reminds everyone and starts
//   listening before it, checks afterwards who was there from what was heard and written, marks each person's
//   scorecard, and says in the space, plainly and to everyone involved, who did not keep it. One account action
//   (`hold-to-it`, tool:hold-to-it) with operations keep, retime, book, remind, check, mark, scorecard, agreements and free_times; schedules run
//   remind and check by themselves.
//
// Non-Negotiable Invariants
//   1. Everything lives in the space: agreements, the scorecard rules and every mark are space items, so each member
//      reads the same record and nobody is held to account in private or alone.
//   2. Points, sources of presence and every word said are DATA (src/hold-to-it.json); nothing here names a person, a
//      team, an app that hears meetings or a kind of meeting.
//   3. Presence is only what was heard or written in the meeting's window; a person with no evidence is counted absent
//      and the message says what was read, never a guess.
//   4. Marks are kept once per agreement, day, person and rule (their source_ref), so checking twice never marks twice.
//   5. Trillion pays for no model here: finding agreements in words is done by the person's own AI, which keeps each
//      one with this tool; this module only schedules, reads evidence and counts.
//
import settings from './from-old-trillion/src/hold-to-it.json' with { type: 'json' };
import { instantAt, timeZoneName, wallTimeOf, weekday } from '../run-work-later-or-on-a-repeat/do-work/wall-time.ts';

export class HoldToItError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const { words, item_kinds: KIND } = settings;
const say = (key, values = {}) => words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const slug = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ---- time in a place ----------------------------------------------------------------------------------------------

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The local day (YYYY-MM-DD) and weekday of an instant in a time zone. */
export function localDay(instant, zone) {
  const { date } = wallTimeOf(instant, zone);
  return { date, weekday: WEEKDAY_NAMES[weekday(date)] };
}

// A session's start: its local date and time in its zone, by the one clock-change rule (parts/timed-action wall-time):
// a time the clocks skip starts at the first minute that exists, a time that happens twice starts the first time.
const startOf = (date, time, zone) => instantAt(date, time, zone, { gap: 'next-valid', fold: 'earlier' });

const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The occurrences of a cadence from `fromDate` for `days` days, each { date, starts, ends } in ms. */
export function occurrences(cadence, fromDate, days) {
  const zone = cadence.time_zone ?? settings.defaults.time_zone;
  const minutes = cadence.minutes ?? settings.defaults.minutes;
  const out = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(fromDate, offset);
    if (cadence.every === 'once' && date !== cadence.date) continue;
    const starts = startOf(date, cadence.at, zone);
    if (cadence.every === 'week' && !(cadence.on ?? []).map(day => day.toLowerCase()).includes(localDay(starts, zone).weekday)) continue;
    out.push({ date, starts, ends: starts + minutes * 60_000 });
  }
  return out;
}

/** A cadence is timed when it says when: a time, and for a one-time session also its day. */
export const isTimed = cadence => Boolean(cadence?.at) && (cadence.every !== 'once' || Boolean(cadence.date));

/** The last occurrence that has ended by `now`, and the next one that has not started. */
export function aroundNow(cadence, now) {
  const zone = cadence.time_zone ?? settings.defaults.time_zone;
  // A one-time session is a single day however far off it is: no window of days can miss it.
  if (cadence.every === 'once') {
    if (!cadence.date || !cadence.at) return { last: null, next: null };
    const starts = startOf(cadence.date, cadence.at, zone);
    const only = { date: cadence.date, starts, ends: starts + (cadence.minutes ?? settings.defaults.minutes) * 60_000 };
    return { last: only.ends <= now ? only : null, next: only.starts > now ? only : null };
  }
  const today = localDay(now, zone).date;
  const near = occurrences(cadence, addDays(today, -8), 17);
  return {
    last: near.filter(each => each.ends <= now).at(-1) ?? null,
    next: near.find(each => each.starts > now) ?? null,
  };
}

// ---- who was there ------------------------------------------------------------------------------------------------

const forms = (name, aliases = {}) => {
  const all = [name, ...(aliases[name] ?? [])].filter(Boolean).map(each => each.toLowerCase().trim());
  return new Set([...all, ...all.map(each => each.split(/\s+/)[0])]);
};

/** Which of `people` the evidence names: evidence is [{ name, at }] (a speaker heard, a member who wrote). */
export function presentAmong(people, evidence, aliases = {}) {
  const heard = evidence.map(each => String(each.name ?? '').toLowerCase().trim()).filter(Boolean);
  return people.filter(person => {
    const known = forms(person, aliases);
    return heard.some(name => known.has(name) || known.has(name.split(/\s+/)[0]));
  });
}

/** The marks one checked occurrence earns: [{ person, mark }] from the DATA rows by what happened. */
//   Voices heard during it that have no name could be anyone, so a person not recognised is never scored absent (or
//   the meeting never arranged) on that evidence: they are marked unclear, worth nothing, until the voices are named.
export function marksFor({ people, present, arranged, unnamed = 0 }) {
  const rule = kind => settings.marks.find(row => row.when === kind);
  if (!arranged) return people.map(person => ({ person, mark: rule(unnamed ? 'unclear' : 'not_arranged') }));
  return people.map(person => ({ person, mark: rule(present.includes(person) ? 'present' : unnamed ? 'unclear' : 'absent') }));
}

/**
 * Points per person from marks [{ body: { person, points, agreement, date } }], newest first → [{ name, points,
 * missed_in_a_row, areas }]. A person has one mark per agreement and day: a newer mark for the same day (a correction
 * with mark) replaces the older one.
 */
export function tally(markItems) {
  const people = new Map();
  const counted = new Set();
  for (const item of markItems) {
    const { person, points, miss, area, agreement, date } = item.body ?? {};
    if (!person) continue;
    if (agreement && date) {
      const key = JSON.stringify([agreement, date, person, area ?? null]);
      if (counted.has(key)) continue;
      counted.add(key);
    }
    const row = people.get(person) ?? { name: person, points: 0, missed_in_a_row: 0, areas: {}, streak_open: true };
    row.points += Number(points) || 0;
    // A merit area (what the mark is about: showing up, a skill, a part of the work) keeps its own sum.
    const named = area ?? 'showing up';
    row.areas[named] = (row.areas[named] ?? 0) + (Number(points) || 0);
    if (row.streak_open) {
      if (miss) row.missed_in_a_row += 1;
      else row.streak_open = false;
    }
    people.set(person, row);
  }
  return [...people.values()].map(({ streak_open: _, ...row }) => row).sort((a, b) => a.points - b.points || a.name.localeCompare(b.name));
}

const when = (instant, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant));
const list = names => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---- the tool -----------------------------------------------------------------------------------------------------

/**
 * io: { network, relay, readMessages({ app, before, limit }), schedule(input), tell(notice), runTool(input), findSpaceTimes(input), now() }
 * network carries the space calls a member makes (space, spaceItems, addSpaceItems, spaceEvents, createEvent), each
 * with { relay }.
 */
export function makeHoldToIt(io) {
  const { network, relay } = io;
  const now = () => io.now?.() ?? Date.now();

  // A time chosen after the agreement was kept (retime) is kept as facts on its item and wins over the words it was
  // kept with.
  const timed = item => {
    const { at, date, time_zone: zone, minutes, on } = item.facts ?? {};
    if (!at) return item;
    const cadence = { ...(item.body.cadence ?? { every: 'day' }), at, ...(date ? { date } : {}), ...(zone ? { time_zone: zone } : {}), ...(minutes ? { minutes: Number(minutes) } : {}), ...(on ? { on: String(on).split(',') } : {}) };
    return { ...item, body: { ...item.body, cadence } };
  };

  async function agreement(spaceId, agreementId) {
    let before = null;
    for (let page = 0; page < 5; page += 1) {
      const read = await network.spaceItems({ relay, space_id: spaceId, kind: KIND.agreement, before, limit: 50 });
      const found = read.items.find(item => item.item_id === agreementId);
      if (found) return timed(found);
      if (!read.next_before) break;
      before = read.next_before;
    }
    throw new HoldToItError(say('no_agreement', { agreement_id: agreementId }));
  }

  const post = (spaceId, items) => network.addSpaceItems({ relay, space_id: spaceId, items, app: 'Trillion' });
  const say_in_space = (spaceId, said, sourceRef, about = []) => post(spaceId, [{ kind: KIND.message, body: { text: said }, source_ref: sourceRef, about }]);

  // The space's calendar holds the next meeting of an agreement; adds it when it is not there.
  async function book(spaceId, item) {
    const { cadence, what } = item.body;
    if (!isTimed(cadence)) return null;
    const zone = cadence.time_zone ?? settings.defaults.time_zone;
    const { next } = aroundNow(cadence, now());
    if (!next) return null;
    const title = item.title ?? what;
    const existing = await network.spaceEvents({ relay, community_id: spaceId, from: new Date(next.starts - 60_000).toISOString(), to: new Date(next.ends).toISOString() });
    const there = existing.events.find(event => event.title === title && Math.abs(Date.parse(event.starts_at) - next.starts) < 60_000);
    if (there) return { event_id: there.event_id, starts_at: there.starts_at, title, said: say('booked', { title, starts: when(next.starts, zone) }) };
    const made = await network.createEvent({ relay, community_id: spaceId, title, about: item.body.quote ?? what, starts_at: new Date(next.starts).toISOString(), ends_at: new Date(next.ends).toISOString() });
    return { event_id: made.event_id, starts_at: new Date(next.starts).toISOString(), title, said: say('booked', { title, starts: when(next.starts, zone) }) };
  }

  async function evidenceIn(spaceId, starts, ends) {
    const from = starts - settings.evidence.before_minutes * 60_000;
    const to = ends + settings.evidence.after_minutes * 60_000;
    const seen = [];
    const read = [];
    for (const app of settings.evidence.message_apps) {
      let before;
      for (let page = 0; page < settings.evidence.pages; page += 1) {
        const got = await io.readMessages({ app, before, limit: 100 });
        const rows = got.messages ?? [];
        for (const message of rows) {
          const at = Date.parse(message.at);
          if (at >= from && at <= to && message.speaker) seen.push({ name: message.speaker, at: message.at, where: app });
        }
        if (rows.length) read.push(app);
        if (!got.next_before || rows.some(message => Date.parse(message.at) < from)) break;
        before = got.next_before;
      }
    }
    if (settings.evidence.space_messages) {
      const items = await network.spaceItems({ relay, space_id: spaceId, kind: KIND.message, limit: 100 });
      for (const item of items.items) {
        const at = Date.parse(item.provenance?.added_at);
        if (at >= from && at <= to && item.provenance?.by && item.provenance.app !== 'Trillion') seen.push({ name: item.provenance.by, at: item.provenance.added_at, where: 'space' });
      }
      read.push('space');
    }
    return { seen, read: [...new Set(read)] };
  }

  // Books the next meeting and sets the agreement's one reminder and one check. The schedule ids come from the
  // agreement, so arming it again (a retried call, a new time) changes those two schedules instead of adding more.
  async function arm(spaceId, item) {
    const { cadence, what } = item.body;
    const booked = await book(spaceId, item);
    const zone = cadence.time_zone;
    const offsetTime = (time, plus) => {
      const [hour, minute] = time.split(':').map(Number);
      const total = hour * 60 + minute + plus;
      const dayShift = Math.floor(total / 1440);
      const minuteOfDay = ((total % 1440) + 1440) % 1440;
      return { at: `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`, dayShift };
    };
    const every = plus => {
      if (cadence.every === 'once') return null;
      const shifted = offsetTime(cadence.at, plus);
      const base = { unit: cadence.every === 'week' ? 'week' : 'day', at: shifted.at, time_zone: zone };
      if (cadence.every !== 'week') return base;
      return { ...base, on: (cadence.on ?? []).map(day => {
        const index = WEEKDAY_NAMES.indexOf(String(day).toLowerCase());
        return index < 0 ? day : WEEKDAY_NAMES[((index + shifted.dayShift) % 7 + 7) % 7];
      }) };
    };
    const onceAt = plus => new Date(startOf(cadence.date ?? localDay(now(), zone).date, cadence.at, zone) + plus * 60_000).toISOString();
    const schedule = (operation, plus, label) => io.schedule({
      schedule_id: `hold-${operation}-${slug(item.item_id)}`.slice(0, 80),
      ...(every(plus) ? { every: every(plus) } : { once_at: onceAt(plus) }),
      label, then: { tool_id: 'tool:hold-to-it', input: { operation, space_id: spaceId, agreement_id: item.item_id } },
    });
    const reminder = await schedule('remind', -settings.defaults.remind_minutes, `Remind everyone before ${what}`);
    const checker = await schedule('check', (cadence.minutes ?? settings.defaults.minutes) + settings.defaults.check_after_minutes, `Check who came to ${what}`);
    return { booked, schedules: [reminder?.schedule_id, checker?.schedule_id].filter(Boolean) };
  }

  const operations = {
    // { space_id, what, agreed_by: [names], proposed_by?, cadence?: { every: day | week | once, at: HH:MM, on?, date?, minutes?, time_zone? }, quote?, source_ref?, aliases? }
    async keep(input) {
      const spaceId = text(input.space_id);
      if (!spaceId) throw new HoldToItError(words.needs_space);
      const what = text(input.what);
      if (!what) throw new HoldToItError(words.needs_what);
      const agreedBy = (input.agreed_by ?? []).map(text).filter(Boolean);
      if (!agreedBy.length) throw new HoldToItError(words.needs_who);
      // How often comes from what was said; the time only when someone said it (no time is never guessed).
      const asked = input.cadence ?? {};
      // A zone that is said is kept in its own name, or refused; it is never read as UTC.
      const zone = timeZoneName(asked.time_zone ?? settings.defaults.time_zone);
      if (!zone) throw new HoldToItError(say('bad_zone', { zone: String(asked.time_zone) }));
      const cadence = { every: asked.every ?? 'day', ...(asked.at ? { at: asked.at } : {}), ...(asked.on ? { on: asked.on } : {}), ...(asked.date ? { date: asked.date } : {}), minutes: asked.minutes ?? settings.defaults.minutes, time_zone: zone };
      const body = { what, agreed_by: agreedBy, ...(text(input.proposed_by) ? { proposed_by: text(input.proposed_by) } : {}), cadence, ...(text(input.quote) ? { quote: text(input.quote) } : {}), ...(input.aliases ? { aliases: input.aliases } : {}), ...(text(input.heard_in) ? { heard_in: text(input.heard_in) } : {}) };
      const sourceRef = text(input.source_ref) ?? `agreement:${slug(what)}`;
      // The rules every member is held to, once per space, so the scorecard is read from the space itself.
      await post(spaceId, [{ kind: KIND.rules, title: 'How the scorecard counts', body: { marks: settings.marks.map(({ label, points }) => ({ label, points })) }, source_ref: 'hold-to-it:rules' }]);
      const { ids } = await post(spaceId, [{ kind: KIND.agreement, title: what, body, source_ref: sourceRef }]);
      const item = timed({ item_id: ids[0], title: what, body, facts: (await network.spaceItems({ relay, space_id: spaceId, kind: KIND.agreement, limit: 50 })).items.find(row => row.item_id === ids[0])?.facts });
      const held = item.body.cadence;
      const timeWords = held.at ? say('at_time', { at: held.at }) : '';
      const cadenceWords = held.every === 'week' ? say('cadence_week', { on: (held.on ?? []).join(', '), at: timeWords }) : held.every === 'once' ? say('cadence_once', { date: held.date ? ` on ${held.date}` : '', at: timeWords }) : say('cadence_day', { at: timeWords });
      const said = say(isTimed(held) ? 'kept' : 'kept_no_time', { what, who: list(agreedBy), cadence: cadenceWords.trim(), remind: settings.defaults.remind_minutes });
      await say_in_space(spaceId, said, `${sourceRef}:kept`, [item.item_id]);
      if (!isTimed(held)) {
        // Nobody said when: nothing is booked on a guess. The person is asked to choose, with the time their AI found
        // free on everyone's calendars when it gave one.
        const suggested = /^\d{2}:\d{2}$/.test(String(input.suggested_at ?? '')) ? input.suggested_at : null;
        await io.tell({ kind: 'needs-you', about: { kind: 'space', id: spaceId, item: item.item_id }, key: `hold-time:${item.item_id}`, title: say('choose_time_title', { what }), body: say(suggested ? 'choose_time_suggested' : 'choose_time', { what, who: list(agreedBy), how: cadenceWords, suggested }) }).catch(() => null);
        return { agreement_id: item.item_id, needs_time: true, suggested_at: suggested, said };
      }
      const armed = await arm(spaceId, item);
      return { agreement_id: item.item_id, ...armed, said: `${said} ${armed.booked?.said ?? ''}`.trim() };
    },

    // { space_id, agreement_id, suggested_at?, because? }: asks the person, in their needs-you notices, to choose or
    // confirm the agreement's time (a time kept from words that did not clearly set it, or none at all).
    async ask_time({ space_id: spaceId, agreement_id: agreementId, suggested_at: suggested, because }) {
      const item = await agreement(spaceId, agreementId);
      const what = item.title ?? item.body.what;
      const at = /^\d{2}:\d{2}$/.test(String(suggested ?? '')) ? suggested : item.body.cadence?.at ?? null;
      const how = say(item.body.cadence?.every === 'week' ? 'cadence_week' : item.body.cadence?.every === 'once' ? 'cadence_once' : 'cadence_day', { on: (item.body.cadence?.on ?? []).join(', '), date: item.body.cadence?.date ? ` on ${item.body.cadence.date}` : '', at: '' }).trim();
      const body = `${say(at ? 'choose_time_suggested' : 'choose_time', { what, who: list(item.body.agreed_by), how, suggested: at })}${text(because) ? ` ${text(because)}` : ''}`;
      await io.tell({ kind: 'needs-you', about: { kind: 'space', id: spaceId, item: agreementId }, key: `hold-time:${agreementId}`, title: say('choose_time_title', { what }), body });
      return { agreement_id: agreementId, suggested_at: at, said: body };
    },

    // { space_id, agreement_id, at: HH:MM, date?: YYYY-MM-DD (a one-time session's day), time_zone?, minutes?, on?: [weekdays], because? }: gives an agreement its
    // time (or a new one), moves its next meeting on the space's calendar, moves the reminder and the check with it, and
    // says once in the space that it moved and why.
    async retime({ space_id: spaceId, agreement_id: agreementId, at, date, time_zone: zone, minutes, on, because }) {
      if (!/^\d{2}:\d{2}$/.test(String(at ?? ''))) throw new HoldToItError(words.needs_at);
      const before = await agreement(spaceId, agreementId);
      const hadTime = isTimed(before.body.cadence);
      await network.setSpaceItemFacts({ relay, space_id: spaceId, item_id: agreementId, facts: { at, ...(/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? { date } : {}), ...(text(zone) ? { time_zone: text(zone) } : {}), ...(minutes ? { minutes: Number(minutes) } : {}), ...(Array.isArray(on) && on.length ? { on: on.join(',') } : {}) } });
      const item = await agreement(spaceId, agreementId);
      const { cadence } = item.body;
      const tz = cadence.time_zone ?? settings.defaults.time_zone;
      const title = item.title ?? item.body.what;
      const { next } = aroundNow(cadence, now());
      // The meeting already booked at the old time moves to the new one rather than leaving two.
      if (hadTime && next) {
        const booked = await network.spaceEvents({ relay, community_id: spaceId, from: new Date(now()).toISOString(), to: new Date(now() + 8 * 86_400_000).toISOString() });
        const old = booked.events.filter(event => event.title === title && Math.abs(Date.parse(event.starts_at) - next.starts) >= 60_000);
        if (old.length) await network.moveEvent({ relay, community_id: spaceId, event_id: old[0].event_id, starts_at: new Date(next.starts).toISOString(), ends_at: new Date(next.ends).toISOString(), quiet: true });
      }
      const armed = await arm(spaceId, item);
      const said = say(hadTime ? 'moved' : 'timed', { title, when: armed.booked ? when(Date.parse(armed.booked.starts_at), tz) : at, because: text(because) ? ` ${text(because)}` : '' });
      await say_in_space(spaceId, said, `retime:${agreementId}:${at}:${now()}`, [agreementId]);
      return { agreement_id: agreementId, ...armed, said };
    },

    async book({ space_id: spaceId, agreement_id: agreementId }) {
      return (await book(spaceId, await agreement(spaceId, agreementId))) ?? { said: 'Nothing left to book.' };
    },

    async remind({ space_id: spaceId, agreement_id: agreementId }) {
      const item = await agreement(spaceId, agreementId);
      if (!isTimed(item.body.cadence)) return { said: words.no_time };
      const { next } = aroundNow(item.body.cadence, now() - 60 * 60_000);
      const title = item.title ?? item.body.what;
      const said = say('remind', { title, minutes: settings.defaults.remind_minutes, who: list(item.body.agreed_by) });
      await say_in_space(spaceId, said, `remind:${agreementId}:${next ? new Date(next.starts).toISOString().slice(0, 10) : 'now'}`, [agreementId]);
      await io.tell({ title: `${title} soon`, body: said, kind: 'meeting', about: { kind: 'space', id: spaceId, item: agreementId }, key: `remind:${agreementId}:${localDay(now(), item.body.cadence.time_zone).date}` }).catch(() => null);
      // Listening on before the meeting, on the person's own computer, so who came is known (best effort: no computer, no change).
      const listening = await io.runTool({ tool_id: 'tool:listen', input: { on: true }, request_key: `hold-to-it:listen:${agreementId}:${now()}`, wait_seconds: 10, job: `listen during ${title}` }).catch(error => ({ state: 'failed', error: String(error.message ?? error) }));
      return { said, listening: listening?.state ?? null };
    },

    async check({ space_id: spaceId, agreement_id: agreementId }) {
      const item = await agreement(spaceId, agreementId);
      if (!isTimed(item.body.cadence)) return { said: words.no_time };
      const { cadence, agreed_by: people, aliases = {} } = item.body;
      const zone = cadence.time_zone;
      const title = item.title ?? item.body.what;
      const { last, next } = aroundNow(cadence, now());
      if (!last) return { said: 'No meeting has happened yet.' };
      const events = await network.spaceEvents({ relay, community_id: spaceId, from: new Date(last.starts - 60_000).toISOString(), to: new Date(last.ends).toISOString() });
      const arranged = events.events.some(event => Math.abs(Date.parse(event.starts_at) - last.starts) < 2 * 60 * 60_000);
      const { seen, read } = await evidenceIn(spaceId, last.starts, last.ends);
      const present = presentAmong(people, seen, aliases);
      const unnamed = new Set(seen.map(each => each.name).filter(name => name.startsWith(settings.evidence.unnamed_prefix))).size;
      const marks = marksFor({ people, present, arranged, unnamed });
      await post(spaceId, marks.map(({ person, mark }) => ({
        kind: KIND.mark, title: `${person}: ${mark.label}`,
        body: { person, rule: mark.id, points: mark.points, miss: Boolean(mark.miss), agreement: title, date: last.date, evidence: read },
        about: [agreementId], source_ref: `mark:${agreementId}:${last.date}:${slug(person)}`,
      })));
      const booked = await book(spaceId, item);
      const nextWords = booked ? when(Date.parse(booked.starts_at), zone) : next ? when(next.starts, zone) : 'not set';
      const absent = people.filter(person => !present.includes(person));
      const unclear = marks.filter(({ mark }) => mark.when === 'unclear').map(({ person }) => person);
      const said = unclear.length ? say('unclear', { title, count: unnamed, who: list(unclear), next: nextWords })
        : !arranged ? say('not_arranged', { title, who: list(people), next: nextWords })
        : !absent.length ? say('nobody_missed', { title, who: list(present) })
          : !present.length ? say('nobody_came', { title, absent: list(absent), next: nextWords })
            : say('missed', { title, absent: list(absent), present: list(present), next: nextWords });
      const scored = tally((await network.spaceItems({ relay, space_id: spaceId, kind: KIND.mark, limit: 200 })).items.filter(mark => mark.about?.includes(agreementId)));
      const streaks = scored.filter(row => row.missed_in_a_row >= 2).map(row => say('streak', { name: row.name, count: row.missed_in_a_row }));
      const full = [said, ...streaks].join(' ');
      await say_in_space(spaceId, full, `check:${agreementId}:${last.date}`, [agreementId]);
      await io.tell({ title, body: full, kind: 'meeting', about: { kind: 'space', id: spaceId, item: agreementId }, key: `check:${agreementId}:${last.date}` }).catch(() => null);
      return { date: last.date, arranged, present, absent, unnamed_voices: unnamed, evidence: read, marks: marks.map(({ person, mark }) => ({ person, mark: mark.id, points: mark.points })), said: full };
    },

    // Any member's AI marks a person against an agreement with what shows it (agreed, and did not do it).
    // A mark for a day that already has one (date, an earlier day) replaces it in the scorecard: that is how a wrong
    // mark is corrected, with the evidence kept beside it.
    async mark({ space_id: spaceId, agreement_id: agreementId, person, rule, evidence, area, date: asked }) {
      const item = await agreement(spaceId, agreementId);
      const row = settings.marks.find(each => each.id === rule);
      if (!row || !text(person)) throw new HoldToItError(`Say who (person) and which mark (rule): ${settings.marks.map(each => each.id).join(', ')}.`);
      if (asked !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(asked))) throw new HoldToItError('date is the day the mark is for, like 2026-10-05.');
      const date = asked ?? localDay(now(), item.body.cadence?.time_zone ?? settings.defaults.time_zone).date;
      await post(spaceId, [{ kind: KIND.mark, title: `${person}: ${row.label}`, body: { person, rule: row.id, points: row.points, miss: Boolean(row.miss), agreement: item.title, date, evidence: [text(evidence) ?? 'said by a member'], ...(text(area) ? { area: text(area) } : {}) }, about: [agreementId], source_ref: `mark:${agreementId}:${date}:${slug(person)}:${row.id}` }]);
      const said = `${person}: ${row.label} (${row.points}) on ${item.title}.`;
      await say_in_space(spaceId, said, `mark-said:${agreementId}:${date}:${slug(person)}`, [agreementId]);
      return { said };
    },

    async scorecard({ space_id: spaceId }) {
      const marks = (await network.spaceItems({ relay, space_id: spaceId, kind: KIND.mark, limit: 200 })).items;
      const rows = tally(marks);
      const space = await network.space({ relay, space_id: spaceId });
      return { people: rows, said: rows.length ? say('scorecard', { space: space.title, lines: rows.map(row => say('scorecard_line', { name: row.name, points: row.points })).join(', ') }) : 'No marks yet.' };
    },

    // When every member of the space is free, read from each member's own calendar (src/space-calendars.mjs), so a
    // meeting the group agreed is put where everyone can come.
    async free_times(input) {
      if (!io.findSpaceTimes) throw new HoldToItError('This account cannot read members\' calendars here.');
      return io.findSpaceTimes(input);
    },

    async agreements({ space_id: spaceId }) {
      const read = await network.spaceItems({ relay, space_id: spaceId, kind: KIND.agreement, limit: 50 });
      return { agreements: read.items.map(item => ({ agreement_id: item.item_id, what: item.title, ...item.body })) };
    },
  };

  return {
    async run({ operation, ...input } = {}) {
      if (!Object.hasOwn(operations, operation)) throw new HoldToItError(words.operation);
      return operations[operation](input);
    },
  };
}

/** The account action a person store mixes in (tool:hold-to-it). */
export const holdToItActions = store => ({
  'hold-to-it': input => makeHoldToIt(store.holdToItIo()).run(input ?? {}),
});
