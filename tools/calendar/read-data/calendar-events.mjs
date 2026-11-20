// tools/calendar/read-data/calendar-events.mjs
//
// Purpose: the one entry the calendar reading row runs (through tools/workflows/do-work/run-a-function.mjs). It reads
// the provider the run names from read-data/calendar-providers.json, takes the person's key from the descriptor the
// engine handed this run, and gives the request to the provider's adapter (read-data/adapters/<adapter>.mjs), which
// asks the provider for the events of one calendar in a range and gives them back as time blocks. Nothing here names a
// provider or a wire format.
//
// Non-Negotiable Invariants:
// 1. The key is read from descriptor 4 only when a request needs it, kept in this run's memory, and placed only in the
//    Authorization header (or, for a Composio connection, the x-api-key header) of a request to a host of the provider's
//    row, over https, never followed by a redirect.
// 2. A provider that does not offer an operation is refused before any request leaves, in the words of its row.
// 3. It reads only: no request it makes creates, changes or removes an event.

import { readFileSync } from 'node:fs';
import { makeComposioCall } from '../../composio-connection/read-data/composio-call.mjs';

const HELD_DESCRIPTOR = 4;
const SAID = 300;
const rows = JSON.parse(readFileSync(new URL('./calendar-providers.json', import.meta.url), 'utf8'));

export class Refused extends Error {}

const fill = (words, values) => Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(String(value)), words);
const providerIds = () => rows.providers.map(row => row.id).join(', ');
const jobOf = operation => operation.replace(/-/g, ' ');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The provider row an input names. */
export function providerFor(input) {
  const named = input?.provider;
  if (typeof named !== 'string' || !named) throw new Refused(fill(rows.words.no_provider, { providers: providerIds() }));
  const provider = rows.providers.find(row => row.id === named);
  if (!provider) throw new Refused(fill(rows.words.no_such_provider, { provider: named, providers: providerIds() }));
  return provider;
}

/** Input problems, all of them, or an empty list. */
export function rangeProblems(input) {
  const problems = [];
  for (const name of ['range_start', 'range_end']) {
    if (typeof input[name] !== 'string' || Number.isNaN(Date.parse(input[name]))) problems.push(`${name} must be an ISO time`);
  }
  if (problems.length === 0 && Date.parse(input.range_end) <= Date.parse(input.range_start)) problems.push('range_end must be after range_start');
  if (input.calendar_id != null && (typeof input.calendar_id !== 'string' || !input.calendar_id)) problems.push('calendar_id must be text');
  if (input.max_results !== undefined && !(Number.isInteger(input.max_results) && input.max_results >= 1 && input.max_results <= 2500)) problems.push('max_results must be a whole number from 1 to 2500');
  return problems;
}

/** `call(method, path, {query, headers})`: one GET-style request to the provider's own host, as the person. */
export function makeCall(provider, { read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = {}) {
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused(fill(rows.words.no_key, { label: provider.label }));
    return key;
  };
  return async function call(method, path, { query = {}, headers = {} } = {}) {
    if (method !== 'GET') throw new Refused(fill(rows.words.not_offered, { label: provider.label, job: `${method.toLowerCase()} a calendar` }));
    const whole = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
    const url = whole ? new URL(path) : new URL(provider.base_url + path);
    if (whole && !path.startsWith(provider.base_url)) throw new Refused(fill(rows.words.host, { hosts: provider.hosts.join(', '), host: url.hostname }));
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.append(name, String(value));
    }
    if (url.protocol !== 'https:' || !provider.hosts.includes(url.hostname)) throw new Refused(fill(rows.words.host, { hosts: provider.hosts.join(', '), host: url.hostname }));
    const reply = await send(url, { method, redirect: 'manual', headers: { Authorization: `Bearer ${held()}`, Accept: 'application/json', ...headers } });
    const text = await reply.text();
    if (!reply.ok) throw new Refused(fill(rows.words.refused, { label: provider.label, status: reply.status, said: text.replace(/\s+/g, ' ').trim().slice(0, SAID) }));
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new Refused(fill(rows.words.refused, { label: provider.label, status: reply.status, said: 'the reply was not JSON' })); }
  };
}

/** One event as the time block read-time-blocks and lay-out-a-calendar-view understand. */
export function blockOf(provider, { calendarId, connectionRef }, event) {
  return {
    id: `${provider.id}:${event.id}`,
    source: { lensId: 'events', inputAddress: `${provider.id}.${calendarId}.events`, ownerRef: provider.id, rowRef: String(event.id) },
    interval: { start: event.start, end: event.end || event.start, allDay: Boolean(event.allDay), timezone: event.timezone || 'local' },
    display: { title: event.title || 'Untitled', color: '', ownerLabel: provider.label },
    state: { ref: event.cancelled ? 'cancelled' : 'ready', lane: provider.id },
    relations: { account: connectionRef ? [connectionRef] : [], list: [`${provider.id}:${calendarId}`], linkedRecord: event.link ? [event.link] : [], conflict: [] },
  };
}

/** Reads the events of one calendar in a range. The second argument is the run's host actions, which this tool never uses
 * (touching them would load host-actions.mjs, which this row does not pack); `io` is only for tests: the descriptor reader
 * and the fetch. */
export async function readCalendarEvents(input = {}, _host = undefined, io = {}) {
  if (!isRecord(input)) throw new Refused('Give { provider, connection, range_start, range_end }.');
  const provider = providerFor(input);
  const operation = 'read-calendar-events';
  if (!provider.operations.includes(operation) || !/^[a-z-]+$/.test(provider.adapter)) throw new Refused(fill(rows.words.not_offered, { label: provider.label, job: jobOf(operation) }));
  const problems = rangeProblems(input);
  if (problems.length) throw new Refused(problems.join('; '));
  const adapter = await import(`./adapters/${provider.adapter}.mjs`);
  const calendarId = input.calendar_id ?? null;
  // A Composio connection kind reaches the account through one execute call (composio-connection); any other kind is the
  // provider's own host with the held key as a bearer token.
  const reach = provider.connection?.kind === 'composio'
    ? { execute: makeComposioCall(io), accountId: input.connection?.connection_id, userId: input.connection?.user_id }
    : { call: makeCall(provider, io) };
  const events = await adapter.readEvents(reach, {
    calendarId,
    rangeStart: new Date(input.range_start).toISOString(),
    rangeEnd: new Date(input.range_end).toISOString(),
    maxResults: input.max_results ?? 50,
  });
  const listed = calendarId ?? 'primary';
  const blocks = events.filter(event => event.id && event.start).map(event => blockOf(provider, { calendarId: listed, connectionRef: input.connection?.connection_id }, event));
  return {
    blocks,
    issues: blocks.length ? [] : [{ id: 'sync-empty', tone: 'info', label: 'No events found.', detail: fill(rows.words.empty, { label: provider.label }) }],
    range_start: new Date(input.range_start).toISOString(),
    range_end: new Date(input.range_end).toISOString(),
    source: { provider: provider.id, event_count: blocks.length },
  };
}
