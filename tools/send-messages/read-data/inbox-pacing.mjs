// tools/send-messages/read-data/inbox-pacing.mjs
//
// How fast one sending inbox may send, and what each bounce, reply or complaint that comes back means. Every number,
// weekday, hour, word and action is a row of inbox-pacing.json (or the person's own row in the request); the code knows
// the closed set of tests a row may name (equals, matching, pattern) and nothing about any provider, trade or person.
// It sends nothing and keeps nothing: planSends says when each address may be sent to, sortOutcomes says what each event
// means and which addresses to leave alone. The send tools do the sending.

import { readFileSync } from 'node:fs';

export const PACING = JSON.parse(readFileSync(new URL('./inbox-pacing.json', import.meta.url), 'utf8'));

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EVENT_FIELDS = ['recipient', 'type', 'status', 'subject', 'text', 'at'];
const TESTS = ['equals', 'matching', 'pattern'];
const DAY_MS = 86_400_000;
const MAX_RECIPIENTS = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isInteger(value) && value > 0;
const address = value => (typeof value === 'string' ? value : value?.address ?? '').trim().toLowerCase();

// ---------- rows ----------

/** Every problem with a pacing row, each saying what to change. */
export function pacingProblems(row) {
  const problems = [];
  if (!object(row)) return ['A pacing row must be an object.'];
  const where = `Pacing row ${row.id ?? '(no id)'}`;
  if (typeof row.id !== 'string' || !row.id) problems.push('A pacing row needs an id.');
  if (!Array.isArray(row.ramp) || !row.ramp.length) problems.push(`${where}: ramp must list at least one { from_day, per_day }.`);
  else row.ramp.forEach((step, index) => {
    if (!positive(step?.from_day) || !positive(step?.per_day)) problems.push(`${where}: ramp[${index}] needs from_day and per_day as whole numbers above 0.`);
    else if (index === 0 && step.from_day !== 1) problems.push(`${where}: the ramp must start at from_day 1.`);
    else if (index > 0 && !(step.from_day > row.ramp[index - 1]?.from_day)) problems.push(`${where}: ramp from_day must go up.`);
  });
  if (!(typeof row.min_gap_minutes === 'number' && row.min_gap_minutes >= 0)) problems.push(`${where}: min_gap_minutes must be 0 or more.`);
  if (!Array.isArray(row.weekdays) || !row.weekdays.length || row.weekdays.some(day => !WEEKDAYS.includes(day))) problems.push(`${where}: weekdays must list days from ${WEEKDAYS.join(', ')}.`);
  const hours = row.hours;
  if (!object(hours) || !Number.isInteger(hours.from) || !Number.isInteger(hours.to) || hours.from < 0 || hours.to > 24 || hours.from >= hours.to) problems.push(`${where}: hours must be { from, to } whole local hours with 0 <= from < to <= 24.`);
  if (!(Number.isInteger(row.leave_address_days) && row.leave_address_days >= 0)) problems.push(`${where}: leave_address_days must be a whole number, 0 or more.`);
  const pause = row.pause_when;
  if (!object(pause) || !positive(pause.last_sends) || !(typeof pause.bounce_share_at_least === 'number' && pause.bounce_share_at_least > 0 && pause.bounce_share_at_least <= 1) || !positive(pause.complaints_at_least)) {
    problems.push(`${where}: pause_when must be { last_sends, bounce_share_at_least (above 0, at most 1), complaints_at_least }.`);
  }
  return problems;
}

/** Every problem with an outcome row, judged by the actions and kinds of the DATA. */
export function outcomeRowProblems(row, data = PACING) {
  const problems = [];
  if (!object(row)) return ['An outcome row must be an object.'];
  const where = `Outcome row ${row.id ?? '(no id)'}`;
  if (typeof row.id !== 'string' || !row.id) problems.push('An outcome row needs an id.');
  if (!Array.isArray(row.when) || !row.when.length) problems.push(`${where}: when must list at least one condition.`);
  else row.when.forEach((condition, index) => {
    if (!EVENT_FIELDS.includes(condition?.field)) problems.push(`${where}: when[${index}].field must be one of ${EVENT_FIELDS.join(', ')}.`);
    const tests = TESTS.filter(test => condition?.[test] !== undefined);
    if (tests.length !== 1) { problems.push(`${where}: when[${index}] must name exactly one of ${TESTS.join(', ')}.`); return; }
    const [test] = tests;
    if (test === 'pattern') { try { new RegExp(condition.pattern, 'i'); } catch { problems.push(`${where}: when[${index}].pattern is not a regular expression.`); } }
    else if (!Array.isArray(condition[test]) || !condition[test].length || condition[test].some(word => typeof word !== 'string' || !word)) problems.push(`${where}: when[${index}].${test} must list words.`);
  });
  if (!data.kinds.includes(row.kind)) problems.push(`${where}: kind must be one of ${data.kinds.join(', ')}.`);
  const actions = data.actions.map(entry => entry.action);
  if (!actions.includes(row.action)) problems.push(`${where}: action must be one of ${actions.join(', ')}.`);
  if (row.action === 'retry-later' && !positive(row.retry_after_hours)) problems.push(`${where}: a retry-later row needs retry_after_hours, a whole number above 0.`);
  return problems;
}

/** Every problem with an event-source row: it must say where the recipient and the type are. */
export function eventSourceProblems(row) {
  if (!object(row) || typeof row.id !== 'string' || !object(row.fields)) return ['An event-source row needs an id and fields.'];
  const problems = [];
  for (const field of ['recipient', 'type']) if (typeof row.fields[field] !== 'string') problems.push(`Event source ${row.id}: fields.${field} must name where it is in an event.`);
  for (const field of Object.keys(row.fields)) if (!EVENT_FIELDS.includes(field)) problems.push(`Event source ${row.id}: ${field} is not an event field (${EVENT_FIELDS.join(', ')}).`);
  return problems;
}

function chosen(request, key, rowKey, list, label, problemsOf) {
  const row = request[rowKey] ?? list.find(entry => entry.id === request[key]);
  if (!row) throw new Error(`Send ${key} (one of ${list.map(entry => entry.id).join(', ')}) or your own ${rowKey}; ${request[key] ? `there is no ${label} ${request[key]}` : `no ${label} was given`}.`);
  const problems = problemsOf(row);
  if (problems.length) throw new Error(problems.join(' '));
  return row;
}

// ---------- time ----------

function zoneOf(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) throw new Error('Send time_zone, the sending inbox\'s IANA time zone (such as America/Chicago).');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  } catch { throw new Error(`time_zone ${timeZone} is not a time zone the time zone database knows.`); }
}

function local(format, ms) {
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday.toLowerCase(), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

function instant(value, name) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(ms)) throw new Error(`${name} must be a date and time (ISO 8601), such as 2026-11-07T09:00:00Z.`);
  return ms;
}

const dayBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// ---------- planning sends ----------

/**
 * When each recipient may be sent to from one inbox, under a pacing row. history is every send this inbox made
 * ({ recipient, at }); outcomes is what came back ({ recipient, kind }, as sortOutcomes gives them); suppressed is the
 * addresses never to send to. Answers due_now (send these now), schedule (every slot, first due first), held (left out,
 * with why) and paused (the whole inbox stops while its last sends bounce or draw a complaint).
 */
export function planSends(request, data = PACING) {
  if (!object(request)) throw new Error('Send one JSON object.');
  const row = chosen(request, 'pacing', 'pacing_row', data.pacing, 'pacing row', pacingProblems);
  const format = zoneOf(request.time_zone);
  const now = instant(request.now ?? Date.now(), 'now');
  const recipients = request.recipients ?? [];
  if (!Array.isArray(recipients) || !recipients.length) throw new Error('Send recipients, the addresses to plan for.');
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`Send at most ${MAX_RECIPIENTS} recipients at once.`);
  const history = (request.history ?? []).map((send, index) => ({ recipient: address(send?.recipient), at: instant(send?.at, `history[${index}].at`) }));
  const outcomes = (request.outcomes ?? []).map(outcome => ({ recipient: address(outcome?.recipient), kind: outcome?.kind }));
  const suppressed = new Set((request.suppressed ?? []).map(address));
  // The inbox's day 1 is the local day of its first send: given, else its earliest send, else the first slot planned now.
  const firstMs = request.first_send_at !== undefined ? instant(request.first_send_at, 'first_send_at') : history.length ? Math.min(...history.map(send => send.at)) : null;
  let firstLocal = firstMs === null ? null : local(format, firstMs).date;

  // Pause: the share of the last sends that bounced hard, or any complaint among them.
  const lastSends = [...history].sort((a, b) => b.at - a.at).slice(0, row.pause_when.last_sends);
  const lastRecipients = new Set(lastSends.map(send => send.recipient));
  const among = kind => new Set(outcomes.filter(outcome => outcome.kind === kind && lastRecipients.has(outcome.recipient)).map(outcome => outcome.recipient)).size;
  const bounces = among('hard-bounce');
  const complaints = among('complaint');
  const bounceShare = lastSends.length ? bounces / lastSends.length : 0;
  let paused = null;
  if (complaints >= row.pause_when.complaints_at_least) paused = { why: `${complaints} complaint${complaints === 1 ? '' : 's'} among the last ${lastSends.length} sends`, bounce_share: bounceShare, complaints, last_sends: lastSends.length };
  else if (lastSends.length && bounceShare >= row.pause_when.bounce_share_at_least) paused = { why: `${bounces} of the last ${lastSends.length} sends bounced (${Math.round(bounceShare * 1000) / 10}%), at or over ${row.pause_when.bounce_share_at_least * 100}%`, bounce_share: bounceShare, complaints, last_sends: lastSends.length };

  // Who is left out, and why.
  const outcomeOf = new Map();
  for (const outcome of outcomes) if (!outcomeOf.has(outcome.recipient) || outcome.kind !== 'delivered') outcomeOf.set(outcome.recipient, outcome.kind);
  const leaveSuppressed = new Set(data.outcomes.filter(entry => entry.action === 'suppress').map(entry => entry.kind));
  const leaveStopped = new Set(data.outcomes.filter(entry => entry.action === 'stop-sequence').map(entry => entry.kind));
  const lastSentTo = new Map();
  for (const send of history) lastSentTo.set(send.recipient, Math.max(lastSentTo.get(send.recipient) ?? -Infinity, send.at));
  const held = [];
  const keep = [];
  const seen = new Set();
  for (const entry of recipients) {
    const recipient = address(entry);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) { held.push({ recipient, why: 'not an email address' }); continue; }
    if (seen.has(recipient)) { held.push({ recipient, why: 'listed twice' }); continue; }
    seen.add(recipient);
    const kind = outcomeOf.get(recipient);
    if (suppressed.has(recipient)) held.push({ recipient, why: 'suppressed' });
    else if (leaveSuppressed.has(kind)) held.push({ recipient, why: `suppressed: ${kind}` });
    else if (leaveStopped.has(kind)) held.push({ recipient, why: `${kind}: answer them yourself` });
    else if (lastSentTo.has(recipient) && now - lastSentTo.get(recipient) < row.leave_address_days * DAY_MS) held.push({ recipient, why: `sent to within the last ${row.leave_address_days} days` });
    else if (paused) held.push({ recipient, why: `inbox paused: ${paused.why}` });
    else keep.push(recipient);
  }

  // Slots: each send at least min_gap after the one before, on an allowed weekday, in the allowed hours, under the day's cap.
  const perDay = new Map();
  for (const send of history) { const day = local(format, send.at).date; perDay.set(day, (perDay.get(day) ?? 0) + 1); }
  const capOn = day => [...row.ramp].reverse().find(step => step.from_day <= day)?.per_day ?? 0;
  const gap = row.min_gap_minutes * 60_000;
  let at = Math.ceil(Math.max(now, history.length ? Math.max(...history.map(send => send.at)) + gap : now) / 60_000) * 60_000;
  const schedule = [];
  for (const recipient of keep) {
    for (let tries = 0; ; tries += 1) {
      if (tries > 2000) throw new Error(`Pacing row ${row.id} leaves no time to send in: check its weekdays, hours and ramp.`);
      const here = local(format, at);
      const day = firstLocal === null ? 1 : dayBetween(firstLocal, here.date) + 1;
      const full = (perDay.get(here.date) ?? 0) >= capOn(day);
      if (row.weekdays.includes(here.weekday) && !full && here.hour >= row.hours.from && here.hour < row.hours.to) {
        schedule.push({ recipient, at: new Date(at).toISOString(), local: `${here.weekday} ${here.date} ${String(here.hour).padStart(2, '0')}:${String(here.minute).padStart(2, '0')}`, day });
        perDay.set(here.date, (perDay.get(here.date) ?? 0) + 1);
        firstLocal ??= here.date;
        at += gap || 60_000;
        break;
      }
      // Jump to the start of the allowed hours, today when it is still ahead, else on the next local day.
      const minutes = here.hour < row.hours.from && row.weekdays.includes(here.weekday) && !full
        ? (row.hours.from - here.hour) * 60 - here.minute
        : (24 - here.hour + row.hours.from) * 60 - here.minute;
      at += Math.max(minutes, 1) * 60_000;
    }
  }
  const due_now = schedule.filter(slot => Date.parse(slot.at) <= now).map(slot => slot.recipient);
  const said = paused
    ? `Inbox paused (${paused.why}); nothing is sent. Look at the bounced addresses and the list's source before sending again.`
    : `${due_now.length} to send now, ${schedule.length} planned under ${row.id}, ${held.length} left out.`;
  return { pacing: row.id, time_zone: request.time_zone, paused, due_now, schedule, held, said };
}

// ---------- sorting what came back ----------

function at(value, path) {
  let here = value;
  for (const key of path.split('.')) {
    if (here === null || here === undefined) return undefined;
    here = Array.isArray(here) && /^\d+$/.test(key) ? here[Number(key)] : here[key];
  }
  return here;
}

/** One provider event in the plain shape { recipient, type, status, subject, text, at }, by an event-source row. */
export function eventFields(event, sourceRow) {
  const plain = {};
  for (const [field, path] of Object.entries(sourceRow.fields)) {
    const value = at(event, path);
    if (value !== undefined && value !== null) plain[field] = field === 'recipient' ? address(value) : String(value);
  }
  return plain;
}

function holds(condition, fields) {
  const value = fields[condition.field];
  if (value === undefined) return false;
  if (condition.equals) return condition.equals.includes(value);
  if (condition.matching) { const lower = value.toLowerCase(); return condition.matching.some(word => lower.includes(word.toLowerCase())); }
  return new RegExp(condition.pattern, 'i').test(value);
}

/**
 * What each event that came back means: the first outcome row whose every condition holds names its kind and action.
 * Answers outcomes (feed them to planSends), suppress (never send again), stop (stop this outreach; a person answers),
 * retry (send again once, after the row's hours), replies, and unmatched events, which change nothing.
 */
export function sortOutcomes(request, data = PACING) {
  if (!object(request)) throw new Error('Send one JSON object.');
  const source = chosen({ event_source: 'plain', ...request }, 'event_source', 'event_source_row', data.event_sources, 'event source', eventSourceProblems);
  const rows = request.outcome_rows ?? data.outcomes;
  if (!Array.isArray(rows) || !rows.length) throw new Error('outcome_rows must list at least one outcome row.');
  const problems = rows.flatMap(row => outcomeRowProblems(row, data));
  if (problems.length) throw new Error(problems.join(' '));
  if (!Array.isArray(request.events)) throw new Error('Send events, the bounces, replies and notices that came back.');
  const outcomes = [];
  const unmatched = [];
  request.events.forEach((event, index) => {
    const fields = eventFields(event, source);
    if (!fields.recipient) { unmatched.push({ index, why: `no recipient at ${source.fields.recipient}` }); return; }
    const row = rows.find(entry => entry.when.every(condition => holds(condition, fields)));
    if (!row) { unmatched.push({ index, recipient: fields.recipient, why: 'no outcome row applies' }); return; }
    const outcome = { recipient: fields.recipient, rule: row.id, kind: row.kind, action: row.action, says: row.says ?? '' };
    if (fields.at) outcome.at = fields.at;
    if (row.action === 'retry-later') {
      const base = Date.parse(fields.at ?? request.now ?? '');
      outcome.retry_at = new Date((Number.isFinite(base) ? base : Date.now()) + row.retry_after_hours * 3_600_000).toISOString();
    }
    outcomes.push(outcome);
  });
  const recipientsWith = action => [...new Set(outcomes.filter(outcome => outcome.action === action).map(outcome => outcome.recipient))];
  const suppress = recipientsWith('suppress');
  const stop = recipientsWith('stop-sequence').filter(recipient => !suppress.includes(recipient));
  const retry = outcomes.filter(outcome => outcome.action === 'retry-later' && !suppress.includes(outcome.recipient)).map(outcome => ({ recipient: outcome.recipient, at: outcome.retry_at }));
  const replies = [...new Set(outcomes.filter(outcome => outcome.kind === 'reply').map(outcome => outcome.recipient))];
  const said = `${outcomes.length} sorted: ${suppress.length} to suppress, ${stop.length} replied or stopped, ${retry.length} to retry; ${unmatched.length} unmatched.`;
  return { event_source: source.id, outcomes, suppress, stop, retry, replies, unmatched, said };
}
