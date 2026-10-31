// tools/hold-to-it/read-data/hold-to-it.mjs
//
// Holds a group to what it agreed. An agreement found in any transcript, message or meeting ("we need to have a meeting
// every day", and everyone said yes) is kept as a record the group reads. For an agreement with a time this works out the
// next meeting, when to remind and when to check, checks afterwards who was there from the evidence it is handed, marks
// each person, and keeps the scorecard. One function, `holdToIt(input, { door })`, with the operations keep, retime,
// agreements, remind, check, mark and scorecard.
//
// Invariants:
//   1. Nothing here names a person, a team, a kind of meeting or an app that hears meetings. The marks and their points,
//      the defaults (meeting length, time zone, minutes before to remind, minutes after to check) are the group's policy,
//      a record of its own or handed in with the request; there is no default.
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
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { addCivilDays, instantAt, timeZoneName, wallTimeOf, weekday } from '../../wall-time/read-data/wall-time.mjs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./hold-to-it.json', import.meta.url), 'utf8'));
const OPERATIONS = ['keep', 'retime', 'agreements', 'remind', 'check', 'mark', 'scorecard'];
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

const startOf = (date, time, zone) => instantAt(date, time, zone, { gap: 'next-valid', fold: 'earlier' });
const localDay = (instant, zone) => { const { date } = wallTimeOf(instant, zone); return { date, weekday: WEEKDAYS[weekday(date)] }; };

/** The occurrences of a cadence from `fromDate` for `days` days, each { date, starts, ends } in ms. */
export function occurrences(cadence, fromDate, days, policy) {
  const zone = cadence.time_zone ?? policy.defaults.time_zone;
  const minutes = cadence.minutes ?? policy.defaults.minutes;
  const out = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addCivilDays(fromDate, offset);
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
  const near = occurrences(cadence, addCivilDays(today, -8), 17, policy);
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

async function readAll(door, type, prefix) {
  const rows = [];
  for await (const record of door.list({ type, ...(prefix ? { prefix } : {}) })) rows.push(record);
  return rows;
}

async function policyOf(input, door, settings) {
  const policy = input.policy ?? await door.read(settings.types.policy, `${settings.types.policy}:${text(input.policy_id) ?? settings.default_policy_id}`);
  if (!policy) refuse(settings.words.no_policy);
  if (!Array.isArray(policy.marks) || !policy.defaults || !timeZoneName(policy.defaults.time_zone) || !(policy.defaults.minutes > 0)) {
    refuse(settings.words.bad_policy);
  }
  return policy;
}

const newestFirst = marks => [...marks].sort((a, b) => b.date.localeCompare(a.date) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
const id = (settings, kind, ...parts) => `${settings.types[kind]}:${parts.join(':')}`;
const hash16 = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice(3, 19);

export async function holdToIt(input, { door, now = () => Date.now() } = {}) {
  const settings = readSettings();
  const { words } = settings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const { operation } = input;
  if (!OPERATIONS.includes(operation)) refuse(`operation is one of: ${OPERATIONS.join(', ')}.`);
  const group = text(input.group) ?? refuse(words.needs_group);
  const policy = await policyOf(input, door, settings);
  const current = now();

  const agreementOf = async agreementId => {
    const value = await door.read(settings.types.agreement, agreementId);
    return value && value.group === group ? value : refuse(fill(words.no_agreement, { agreement_id: agreementId }));
  };
  const writeAgreement = (agreementId, value) => door.write([{ id: agreementId, type: settings.types.agreement, value }], { key: `hold-${hash16(`${agreementId}${JSON.stringify(value)}`)}` });
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
    const zone = timeZoneName(asked.time_zone ?? policy.defaults.time_zone) ?? refuse(fill(words.bad_zone, { zone: String(asked.time_zone) }));
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
    const held = await door.read(settings.types.agreement, agreementId);
    await writeAgreement(agreementId, { ...(held ?? {}), ...value });
    const said = fill(isTimed(cadence) ? words.kept : words.kept_no_time, { what, who: list(agreedBy), remind: policy.defaults.remind_minutes });
    return isTimed(cadence)
      ? { agreement_id: agreementId, said, ...arming(agreementId, cadence) }
      : { agreement_id: agreementId, needs_time: true, said };
  }

  if (operation === 'retime') {
    const agreementId = text(input.agreement_id) ?? refuse(words.needs_agreement);
    if (!HHMM.test(String(input.at ?? ''))) refuse(words.needs_at);
    if (input.date !== undefined && !DAY.test(String(input.date))) refuse(words.needs_date);
    const held = await agreementOf(agreementId);
    const zone = input.time_zone === undefined ? held.cadence.time_zone : timeZoneName(input.time_zone) ?? refuse(fill(words.bad_zone, { zone: String(input.time_zone) }));
    const cadence = { ...held.cadence, at: input.at, ...(input.date ? { date: input.date } : {}), ...(input.minutes ? { minutes: Number(input.minutes) } : {}), ...(Array.isArray(input.on) ? { on: input.on } : {}), time_zone: zone };
    const hadTime = isTimed(held.cadence);
    await writeAgreement(agreementId, { ...held, cadence });
    const armed = arming(agreementId, cadence);
    return { agreement_id: agreementId, ...armed, said: fill(hadTime ? words.moved : words.timed, { what: held.what, at: input.at, because: text(input.because) ? ` ${text(input.because)}` : '' }) };
  }

  if (operation === 'agreements') {
    const rows = (await readAll(door, settings.types.agreement)).filter(row => row.value.group === group);
    return { agreements: rows.map(row => ({ agreement_id: row.id, ...row.value })) };
  }

  if (operation === 'remind') {
    const agreementId = text(input.agreement_id) ?? refuse(words.needs_agreement);
    const held = await agreementOf(agreementId);
    if (!isTimed(held.cadence)) return { said: words.no_time };
    return { said: fill(words.remind, { what: held.what, minutes: policy.defaults.remind_minutes, who: list(held.agreed_by) }), people: held.agreed_by };
  }

  if (operation === 'check') {
    const agreementId = text(input.agreement_id) ?? refuse(words.needs_agreement);
    const held = await agreementOf(agreementId);
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
    await door.write(marks.map(({ person, mark }) => ({
      id: id(settings, 'mark', slug(agreementId), last.date, slug(person), mark.id),
      type: settings.types.mark,
      value: { group, person, rule: mark.id, points: mark.points, miss: Boolean(mark.miss), agreement: agreementId, date: last.date, at: new Date(current).toISOString(), evidence: input.read_from ?? [] },
    })), { key: `hold-check-${hash16(`${agreementId}${last.date}${JSON.stringify(marks)}`)}` });
    const absent = held.agreed_by.filter(person => !present.includes(person));
    const unclear = marks.filter(({ mark }) => mark.when === 'unclear').map(({ person }) => person);
    const nextWords = next ? new Date(next.starts).toISOString() : words.not_set;
    const said = unclear.length ? fill(words.unclear, { what: held.what, count: unnamed, who: list(unclear), next: nextWords })
      : !input.arranged ? fill(words.not_arranged, { what: held.what, who: list(held.agreed_by), next: nextWords })
        : !absent.length ? fill(words.nobody_missed, { what: held.what, who: list(present) })
          : !present.length ? fill(words.nobody_came, { what: held.what, absent: list(absent), next: nextWords })
            : fill(words.missed, { what: held.what, absent: list(absent), present: list(present), next: nextWords });
    const scored = tally(newestFirst((await readAll(door, settings.types.mark)).map(row => row.value).filter(row => row.agreement === agreementId)), settings.default_area);
    const streaks = scored.filter(row => row.missed_in_a_row >= 2).map(row => fill(words.streak, { name: row.name, count: row.missed_in_a_row }));
    return {
      date: last.date, arranged: input.arranged, present, absent, unnamed_voices: unnamed,
      marks: marks.map(({ person, mark }) => ({ person, mark: mark.id, points: mark.points })), said: [said, ...streaks].join(' '),
    };
  }

  if (operation === 'mark') {
    const agreementId = text(input.agreement_id) ?? refuse(words.needs_agreement);
    const held = await agreementOf(agreementId);
    const row = policy.marks.find(each => each.id === input.rule);
    if (!row || !text(input.person)) refuse(fill(words.needs_mark, { rules: policy.marks.map(each => each.id).join(', ') }));
    if (input.date !== undefined && !DAY.test(String(input.date))) refuse(words.needs_date);
    const date = input.date ?? localDay(current, held.cadence.time_zone).date;
    const person = text(input.person);
    await door.write([{
      id: id(settings, 'mark', slug(agreementId), date, slug(person), row.id), type: settings.types.mark,
      value: { group, person, rule: row.id, points: row.points, miss: Boolean(row.miss), agreement: agreementId, date, at: new Date(current).toISOString(), ...(text(input.area) ? { area: text(input.area) } : {}), evidence: text(input.evidence) ? [text(input.evidence)] : [] },
    }], { key: `hold-mark-${hash16(`${agreementId}${date}${person}${row.id}`)}` });
    return { said: fill(words.marked, { person, label: row.label, points: row.points, what: held.what }) };
  }

  const rows = tally(newestFirst((await readAll(door, settings.types.mark)).map(row => row.value).filter(row => row.group === group)), settings.default_area);
  return { people: rows, said: rows.length ? fill(words.scorecard, { lines: rows.map(row => fill(words.scorecard_line, { name: row.name, points: row.points })).join(', ') }) : words.no_marks };
}
