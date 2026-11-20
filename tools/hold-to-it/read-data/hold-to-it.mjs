// tools/hold-to-it/read-data/hold-to-it.mjs
//
// Holds a group to what it agreed. An agreement found in any transcript, message or meeting ("we need to have a meeting
// every day", and everyone said yes) is answered as an agreement the caller keeps. For an agreement with a time this works
// out the next meeting, when to remind and when to check, checks afterwards who was there from the evidence it is handed,
// marks each person, and answers the scorecard. One function, `holdToIt(input, { now })`, with the operations keep,
// retime, remind, check, mark and scorecard. It reads and keeps nothing: the held agreement, the marks already held and
// the policy come in with the request, and the agreement and the marks to keep come back in the answer.
//
// Invariants:
//   1. Nothing here names a person, a team, a kind of meeting or an app that hears meetings. The marks and their points,
//      the defaults (meeting length, time zone, minutes before to remind, minutes after to check) are the group's policy,
//      handed in with the request; there is no default.
//   2. Presence is only what the caller hands in as evidence for the meeting's window ([{ name, at }]: a speaker heard, a
//      member who wrote); a person with no evidence is counted absent, a voice with no name is counted unclear, never a
//      guess. Where the evidence is read from (a call, a chat, a room) is the caller's: reading what was heard needs a
//      listening owner, and until there is one the caller supplies the names it has.
//   3. A mark is kept once per agreement, day, person and rule, so checking twice never marks twice; a newer mark for the
//      same day replaces the older one in the scorecard (that is how a wrong mark is corrected).
//   4. A time nobody said is never guessed: an agreement without one is `needs_time`, and nothing is armed.
//   5. Nothing is sent or booked here. The answer says the times to arm (the reminder and the check, as a repeat or once)
//      and the sentences to say; whoever runs this arms the wake, books the calendar and tells the group.
import { readFileSync } from 'node:fs';
import { addCivilDays, instantAt, timeZoneName, wallTimeOf, weekday } from '../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./hold-to-it.json', import.meta.url), 'utf8'));
const OPERATIONS = ['keep', 'retime', 'remind', 'check', 'mark', 'scorecard', 'agreements', 'ask_time'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const refuse = words => { throw new Error(words); };
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const slug = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const HHMM = /^\d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = names => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---- cadence ----------------------------------------------------------------------------------------------------

/** A cadence is timed when it says when: a time, and for a one-time session also its day. */
export const isTimed = cadence => Boolean(cadence?.at) && (cadence.every !== 'once' || Boolean(cadence.date));

const startOf = (date, time, zone) => instantAt({ date, time, zone, options: { gap: 'next-valid', fold: 'earlier' } });
const localDay = (instant, zone) => { const { date } = wallTimeOf({ instantMs: instant, zone }); return { date, weekday: WEEKDAYS[weekday({ date })] }; };

/** The occurrences of a cadence from `fromDate` for `days` days, each { date, starts, ends } in ms. */
export function occurrences(cadence, fromDate, days, policy) {
  const zone = cadence.time_zone ?? policy.defaults.time_zone;
  const minutes = cadence.minutes ?? policy.defaults.minutes;
  const out = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addCivilDays({ date: fromDate, days: offset });
    if (cadence.every === 'once' && date !== cadence.date) continue;
    const starts = startOf(date, cadence.at, zone);
    if (cadence.every === 'week' && !(cadence.on ?? []).map(day => day.toLowerCase()).includes(localDay(starts, zone).weekday)) continue;
    out.push({ date, starts, ends: starts + minutes * 60_000 });
  }
  return out;
}

/** The last occurrence that has ended by `now`, and the next one that has not started. */
export function aroundNow(cadence, now, policy) {
  const zone = cadence.time_zone ?? policy.defaults.time_zone;
  if (cadence.every === 'once') {
    if (!cadence.date || !cadence.at) return { last: null, next: null };
    const starts = startOf(cadence.date, cadence.at, zone);
    const only = { date: cadence.date, starts, ends: starts + (cadence.minutes ?? policy.defaults.minutes) * 60_000 };
    return { last: only.ends <= now ? only : null, next: only.starts > now ? only : null };
  }
  const today = localDay(now, zone).date;
  const near = occurrences(cadence, addCivilDays({ date: today, days: -8 }), 17, policy);
  return { last: near.filter(each => each.ends <= now).at(-1) ?? null, next: near.find(each => each.starts > now) ?? null };
}

/** The reminder or the check as something to arm: a repeat shifted by `plus` minutes from the meeting's time (the days of a
 *  weekly one shift with it), or one instant for a one-time session. */
export function armAt(cadence, plus, now, policy) {
  const zone = cadence.time_zone ?? policy.defaults.time_zone;
  if (cadence.every === 'once') {
    return { once_at: new Date(startOf(cadence.date ?? localDay(now, zone).date, cadence.at, zone) + plus * 60_000).toISOString() };
  }
  const [hour, minute] = cadence.at.split(':').map(Number);
  const total = hour * 60 + minute + plus;
  const dayShift = Math.floor(total / 1440);
  const minuteOfDay = ((total % 1440) + 1440) % 1440;
  const at = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
  const every = { unit: cadence.every === 'week' ? 'week' : 'day', at, time_zone: zone };
  if (cadence.every !== 'week') return { every };
  return { every: { ...every, on: (cadence.on ?? []).map(day => {
    const index = WEEKDAYS.indexOf(String(day).toLowerCase());
    return index < 0 ? day : WEEKDAYS[((index + dayShift) % 7 + 7) % 7];
  }) } };
}

// ---- who was there ------------------------------------------------------------------------------------------------

const forms = (name, aliases = {}) => {
  const all = [name, ...(aliases[name] ?? [])].filter(Boolean).map(each => each.toLowerCase().trim());
  return new Set([...all, ...all.map(each => each.split(/\s+/)[0])]);
};

/** Evidence from heard turns ([{ start, speaker, ... }], one row per speaker turn): the speaker is the name and the start
 *  the time. A turn whose speaker is a voice with no name, or one of several names, is evidence of an unclear voice only
 *  when the policy's `unnamed_prefixes` say so. */
export function evidenceFromHeard(heard) {
  return (Array.isArray(heard) ? heard : [])
    .filter(row => row && typeof row.speaker === 'string' && row.speaker.trim())
    .map(row => ({ name: row.speaker.trim(), at: row.start }));
}

/** Which of `people` the evidence names: evidence is [{ name, at }] (a speaker heard, a member who wrote). */
export function presentAmong(people, evidence, aliases = {}) {
  const heard = evidence.map(each => String(each.name ?? '').toLowerCase().trim()).filter(Boolean);
  return people.filter(person => {
    const known = forms(person, aliases);
    return heard.some(name => known.has(name) || known.has(name.split(/\s+/)[0]));
  });
}

/** The marks one checked occurrence earns: [{ person, mark }] from the policy's rows by what happened. A voice with no
 *  name could be anyone, so a person not recognised is marked unclear, worth nothing, until the voices are named. */
export function marksFor({ people, present, arranged, unnamed = 0 }, policy) {
  const rule = kind => policy.marks.find(row => row.when === kind) ?? refuse(`The policy has no mark for "${kind}".`);
  if (!arranged) return people.map(person => ({ person, mark: rule(unnamed ? 'unclear' : 'not_arranged') }));
  return people.map(person => ({ person, mark: rule(present.includes(person) ? 'present' : unnamed ? 'unclear' : 'absent') }));
}

/** Points per person from marks [{ person, points, miss?, area?, agreement, date }], newest first. A person has one mark per
 *  agreement and day: a newer mark for the same day replaces the older. */
export function tally(marks, defaultArea) {
  const people = new Map();
  const counted = new Set();
  for (const { person, points, miss, area, agreement, date } of marks) {
    if (!person) continue;
    if (agreement && date) {
      const key = JSON.stringify([agreement, date, person, area ?? null]);
      if (counted.has(key)) continue;
      counted.add(key);
    }
    const row = people.get(person) ?? { name: person, points: 0, missed_in_a_row: 0, areas: {}, streak_open: true };
    row.points += Number(points) || 0;
    const named = area ?? defaultArea;
    row.areas[named] = (row.areas[named] ?? 0) + (Number(points) || 0);
    if (row.streak_open) {
      if (miss) row.missed_in_a_row += 1;
      else row.streak_open = false;
    }
    people.set(person, row);
  }
  return [...people.values()].map(({ streak_open: _, ...row }) => row).sort((a, b) => a.points - b.points || a.name.localeCompare(b.name));
}

// ---- the tool -----------------------------------------------------------------------------------------------------

function policyOf(input, settings) {
  const policy = input.policy ?? refuse(settings.words.no_policy);
  if (!Array.isArray(policy.marks) || !policy.defaults || !timeZoneName({ value: policy.defaults.time_zone }) || !(policy.defaults.minutes > 0)) {
    refuse(settings.words.bad_policy);
  }
  return policy;
}

const newestFirst = marks => [...marks].sort((a, b) => b.date.localeCompare(a.date) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
const id = (settings, kind, ...parts) => `${settings.types[kind]}:${parts.join(':')}`;
const marksOf = input => (Array.isArray(input.marks) ? input.marks.filter(row => row && typeof row === 'object') : []);

/** `holdToIt(input, { now })`: everything it works from is in `input` (the policy, the held agreement, the marks already held) and everything it makes is in the answer; it reads and keeps nothing. */
export function holdToIt(input, { now = () => Date.now() } = {}) {
  const settings = readSettings();
  const { words } = settings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const { operation } = input;
  if (!OPERATIONS.includes(operation)) refuse(`operation is one of: ${OPERATIONS.join(', ')}.`);
  const group = text(input.group) ?? refuse(words.needs_group);
  // The group's agreements as the caller read them from the space (its items: item_id, title, body), in the order given, at most the DATA limit.
  if (operation === 'agreements') {
    const items = Array.isArray(input.agreements) ? input.agreements.filter(row => row && typeof row === 'object') : [];
    return { agreements: items.slice(0, settings.agreements_limit).map(item => ({ agreement_id: item.item_id, what: item.title, ...item.body })) };
  }
  // The person is asked to choose a time for a held agreement that has none: the suggestion is the one given, else its cadence's, and any reason is added.
  if (operation === 'ask_time') {
    const held = input.agreement;
    if (!held || typeof held !== 'object' || !text(held.agreement_id)) refuse(words.needs_agreement);
    if (held.group !== group) refuse(fill(words.no_agreement, { agreement_id: held.agreement_id }));
    const suggested = /^\d{2}:\d{2}$/.test(String(input.suggested_at ?? '')) ? input.suggested_at : (held.cadence?.at ?? null);
    const because = text(input.because);
    const body = fill(suggested ? words.choose_time_suggested : words.choose_time, { what: held.what, who: list(held.agreed_by ?? []), suggested });
    return { agreement_id: held.agreement_id, suggested_at: suggested, said: because ? `${body} ${because}` : body };
  }
  const policy = policyOf(input, settings);
  const current = now();

  const agreementOf = () => {
    const held = input.agreement;
    if (!held || typeof held !== 'object' || !text(held.agreement_id)) refuse(words.needs_agreement);
    return held.group === group ? held : refuse(fill(words.no_agreement, { agreement_id: held.agreement_id }));
  };
  const arming = (agreementId, cadence) => (isTimed(cadence) ? {
    next: (({ next }) => (next ? { starts_at: new Date(next.starts).toISOString(), ends_at: new Date(next.ends).toISOString() } : null))(aroundNow(cadence, current, policy)),
    remind: { schedule_id: `hold-remind-${slug(agreementId)}`.slice(0, 80), ...armAt(cadence, -policy.defaults.remind_minutes, current, policy) },
    check: { schedule_id: `hold-check-${slug(agreementId)}`.slice(0, 80), ...armAt(cadence, (cadence.minutes ?? policy.defaults.minutes) + policy.defaults.check_after_minutes, current, policy) },
  } : null);

  if (operation === 'keep') {
    const what = text(input.what) ?? refuse(words.needs_what);
    const agreedBy = (input.agreed_by ?? []).map(text).filter(Boolean);
    if (!agreedBy.length) refuse(words.needs_who);
    const asked = input.cadence ?? {};
    const zone = timeZoneName({ value: asked.time_zone ?? policy.defaults.time_zone }) ?? refuse(fill(words.bad_zone, { zone: String(asked.time_zone) }));
    if (asked.at !== undefined && !HHMM.test(String(asked.at))) refuse(words.needs_at);
    if (asked.date !== undefined && !DAY.test(String(asked.date))) refuse(words.needs_date);
    const cadence = {
      every: asked.every ?? 'day', ...(asked.at ? { at: asked.at } : {}), ...(asked.on ? { on: asked.on } : {}), ...(asked.date ? { date: asked.date } : {}),
      minutes: asked.minutes ?? policy.defaults.minutes, time_zone: zone,
    };
    const agreementId = id(settings, 'agreement', group, slug(what));
    const value = {
      group, what, agreed_by: agreedBy, cadence,
      ...(text(input.proposed_by) ? { proposed_by: text(input.proposed_by) } : {}), ...(text(input.quote) ? { quote: text(input.quote) } : {}),
      ...(input.aliases && typeof input.aliases === 'object' ? { aliases: input.aliases } : {}), ...(text(input.source_ref) ? { source_ref: text(input.source_ref) } : {}),
    };
    const { agreement_id: heldId, ...held } = input.agreement && input.agreement.agreement_id === agreementId ? input.agreement : {};
    const agreement = { agreement_id: heldId ?? agreementId, ...held, ...value };
    const said = fill(isTimed(cadence) ? words.kept : words.kept_no_time, { what, who: list(agreedBy), remind: policy.defaults.remind_minutes });
    const suggestedAt = /^\d{2}:\d{2}$/.test(String(input.suggested_at ?? '')) ? input.suggested_at : null;
    return isTimed(cadence)
      ? { agreement, said, ...arming(agreementId, cadence) }
      : { agreement, needs_time: true, suggested_at: suggestedAt, said: suggestedAt ? `${said} Suggested: ${suggestedAt}.` : said };
  }

  if (operation === 'retime') {
    if (!HHMM.test(String(input.at ?? ''))) refuse(words.needs_at);
    if (input.date !== undefined && !DAY.test(String(input.date))) refuse(words.needs_date);
    const held = agreementOf();
    const zone = input.time_zone === undefined ? held.cadence.time_zone : timeZoneName({ value: input.time_zone }) ?? refuse(fill(words.bad_zone, { zone: String(input.time_zone) }));
    const cadence = { ...held.cadence, at: input.at, ...(input.date ? { date: input.date } : {}), ...(input.minutes ? { minutes: Number(input.minutes) } : {}), ...(Array.isArray(input.on) ? { on: input.on } : {}), time_zone: zone };
    const hadTime = isTimed(held.cadence);
    const armed = arming(held.agreement_id, cadence);
    return { agreement: { ...held, cadence }, ...armed, said: fill(hadTime ? words.moved : words.timed, { what: held.what, at: input.at, because: text(input.because) ? ` ${text(input.because)}` : '' }) };
  }

  if (operation === 'remind') {
    const held = agreementOf();
    if (!isTimed(held.cadence)) return { said: words.no_time };
    return { said: fill(words.remind, { what: held.what, minutes: policy.defaults.remind_minutes, who: list(held.agreed_by) }), people: held.agreed_by };
  }

  if (operation === 'check') {
    const held = agreementOf();
    const agreementId = held.agreement_id;
    if (!isTimed(held.cadence)) return { said: words.no_time };
    const { last, next } = aroundNow(held.cadence, current, policy);
    if (!last) return { said: words.none_yet };
    if (typeof input.arranged !== 'boolean') refuse(words.needs_arranged);
    const evidence = [...(Array.isArray(input.evidence) ? input.evidence : []), ...evidenceFromHeard(input.heard)].filter(row => row && typeof row.name === 'string');
    const windowed = evidence.filter(row => { const at = Date.parse(row.at); return Number.isNaN(at) || (at >= last.starts - (policy.evidence_before_minutes ?? 0) * 60_000 && at <= last.ends + (policy.evidence_after_minutes ?? 0) * 60_000); });
    const unnamedPrefixes = [policy.unnamed_prefixes ?? []].flat();
    const unnamed = new Set(windowed.map(row => row.name).filter(name => unnamedPrefixes.some(prefix => prefix && name.startsWith(prefix)))).size;
    const present = presentAmong(held.agreed_by, windowed, held.aliases);
    const marks = marksFor({ people: held.agreed_by, present, arranged: input.arranged, unnamed }, policy);
    const made = marks.map(({ person, mark }) => ({
      id: id(settings, 'mark', slug(agreementId), last.date, slug(person), mark.id),
      type: settings.types.mark,
      value: { group, person, rule: mark.id, points: mark.points, miss: Boolean(mark.miss), agreement: agreementId, date: last.date, at: new Date(current).toISOString(), evidence: input.read_from ?? [] },
    }));
    const absent = held.agreed_by.filter(person => !present.includes(person));
    const unclear = marks.filter(({ mark }) => mark.when === 'unclear').map(({ person }) => person);
    const nextWords = next ? new Date(next.starts).toISOString() : words.not_set;
    const said = unclear.length ? fill(words.unclear, { what: held.what, count: unnamed, who: list(unclear), next: nextWords })
      : !input.arranged ? fill(words.not_arranged, { what: held.what, who: list(held.agreed_by), next: nextWords })
        : !absent.length ? fill(words.nobody_missed, { what: held.what, who: list(present) })
          : !present.length ? fill(words.nobody_came, { what: held.what, absent: list(absent), next: nextWords })
            : fill(words.missed, { what: held.what, absent: list(absent), present: list(present), next: nextWords });
    const scored = tally(newestFirst([...marksOf(input), ...made.map(row => row.value)].filter(row => row.agreement === agreementId)), settings.default_area);
    const streaks = scored.filter(row => row.missed_in_a_row >= 2).map(row => fill(words.streak, { name: row.name, count: row.missed_in_a_row }));
    return {
      date: last.date, arranged: input.arranged, present, absent, unnamed_voices: unnamed,
      marks: marks.map(({ person, mark }) => ({ person, mark: mark.id, points: mark.points })), mark_records: made, said: [said, ...streaks].join(' '),
    };
  }

  if (operation === 'mark') {
    const held = agreementOf();
    const row = policy.marks.find(each => each.id === input.rule);
    if (!row || !text(input.person)) refuse(fill(words.needs_mark, { rules: policy.marks.map(each => each.id).join(', ') }));
    if (input.date !== undefined && !DAY.test(String(input.date))) refuse(words.needs_date);
    const date = input.date ?? localDay(current, held.cadence.time_zone).date;
    const person = text(input.person);
    return {
      mark_record: {
        id: id(settings, 'mark', slug(held.agreement_id), date, slug(person), row.id), type: settings.types.mark,
        value: { group, person, rule: row.id, points: row.points, miss: Boolean(row.miss), agreement: held.agreement_id, date, at: new Date(current).toISOString(), ...(text(input.area) ? { area: text(input.area) } : {}), evidence: text(input.evidence) ? [text(input.evidence)] : [] },
      },
      said: fill(words.marked, { person, label: row.label, points: row.points, what: held.what }),
    };
  }

  const rows = tally(newestFirst(marksOf(input).filter(row => row.group === group)), settings.default_area);
  return { people: rows, said: rows.length ? fill(words.scorecard, { lines: rows.map(row => fill(words.scorecard_line, { name: row.name, points: row.points })).join(', ') }) : words.no_marks };
}
