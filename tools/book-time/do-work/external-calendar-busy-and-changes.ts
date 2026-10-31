// tools/book-time/do-work/external-calendar-busy-and-changes.ts
//
// The rest of a booking's life on the host's EXTERNAL calendar, beside create-external-calendar-event.ts:
// reading when the host is busy (so derive-open-slots can subtract it), moving an event to a new time,
// and cancelling it. Same contract as creation: the caller hands an already-resolved connection (the
// package does not own credentials) and a transport; the provider is DATA and selects one adapter from
// the map at the bottom of each entrypoint, so a new provider is one map entry and no caller change.
//
// A busy read that cannot be made returns `status: 'unknown'` with no intervals, never an empty "free"
// answer: a caller that cannot see the host's calendar must say so rather than offer times it guessed.

import { mintGoogleAccessToken, type ExternalCalendarConnection, type FetchLike, type GoogleCalendarConnection } from './create-external-calendar-event.ts';
import type { Interval } from './derive-open-slots.ts';

export interface ExternalBusyResult {
  status: 'read' | 'unknown';
  busy: Interval[];
  error?: string;
}

export interface ExternalChangeResult {
  status: 'changed' | 'error';
  error?: string;
}

const googleCalendarUrl = (conn: GoogleCalendarConnection, path = '') =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}/events${path}`;

async function googleBusy(conn: GoogleCalendarConnection, fromMs: number, toMs: number, doFetch: FetchLike): Promise<ExternalBusyResult> {
  const token = await mintGoogleAccessToken(conn, doFetch);
  if (!token) return { status: 'unknown', busy: [], error: 'token-refresh-failed' };
  const res = await doFetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: conn.calendar_id || 'primary' }] }),
  });
  if (!res.ok) return { status: 'unknown', busy: [], error: `freebusy-${res.status}:${(await res.text()).slice(0, 160)}` };
  const data = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
  const calendar = Object.values(data.calendars ?? {})[0];
  if (!calendar || calendar.errors?.length) return { status: 'unknown', busy: [], error: 'calendar-not-readable' };
  return { status: 'read', busy: (calendar.busy ?? []).map((block) => ({ startMs: Date.parse(block.start), endMs: Date.parse(block.end) })) };
}

async function googleChange(conn: GoogleCalendarConnection, eventId: string, change: { cancel: true } | { start_iso: string; end_iso: string }, doFetch: FetchLike): Promise<ExternalChangeResult> {
  const token = await mintGoogleAccessToken(conn, doFetch);
  if (!token) return { status: 'error', error: 'token-refresh-failed' };
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const res = 'cancel' in change
    ? await doFetch(googleCalendarUrl(conn, `/${encodeURIComponent(eventId)}?sendUpdates=all`), { method: 'DELETE', headers, body: '' })
    : await doFetch(googleCalendarUrl(conn, `/${encodeURIComponent(eventId)}?sendUpdates=all`), { method: 'PATCH', headers, body: JSON.stringify({ start: { dateTime: change.start_iso }, end: { dateTime: change.end_iso } }) });
  // An event already gone is the cancelled state the caller asked for.
  if (res.ok || ('cancel' in change && (res.status === 404 || res.status === 410))) return { status: 'changed' };
  return { status: 'error', error: `${'cancel' in change ? 'delete' : 'patch'}-${res.status}:${(await res.text()).slice(0, 160)}` };
}

/** When the host is busy between two instants, from their connected calendar; `unknown` when it cannot be read. */
export async function readExternalCalendarBusy(connection: ExternalCalendarConnection, fromMs: number, toMs: number, doFetch: FetchLike = fetch as unknown as FetchLike): Promise<ExternalBusyResult> {
  const adapters: Record<string, (c: ExternalCalendarConnection) => Promise<ExternalBusyResult>> = {
    google: (c) => googleBusy(c as GoogleCalendarConnection, fromMs, toMs, doFetch),
  };
  const adapter = adapters[connection.provider];
  return adapter ? adapter(connection) : { status: 'unknown', busy: [], error: `unsupported-provider:${connection.provider}` };
}

/** Moves an event to a new start and end (ISO instants); attendees are told by the provider. */
export async function moveExternalCalendarEvent(connection: ExternalCalendarConnection, eventId: string, startIso: string, endIso: string, doFetch: FetchLike = fetch as unknown as FetchLike): Promise<ExternalChangeResult> {
  const adapters: Record<string, (c: ExternalCalendarConnection) => Promise<ExternalChangeResult>> = {
    google: (c) => googleChange(c as GoogleCalendarConnection, eventId, { start_iso: startIso, end_iso: endIso }, doFetch),
  };
  const adapter = adapters[connection.provider];
  return adapter ? adapter(connection) : { status: 'error', error: `unsupported-provider:${connection.provider}` };
}

/** Cancels an event; attendees are told by the provider. An event already gone counts as cancelled. */
export async function cancelExternalCalendarEvent(connection: ExternalCalendarConnection, eventId: string, doFetch: FetchLike = fetch as unknown as FetchLike): Promise<ExternalChangeResult> {
  const adapters: Record<string, (c: ExternalCalendarConnection) => Promise<ExternalChangeResult>> = {
    google: (c) => googleChange(c as GoogleCalendarConnection, eventId, { cancel: true }, doFetch),
  };
  const adapter = adapters[connection.provider];
  return adapter ? adapter(connection) : { status: 'error', error: `unsupported-provider:${connection.provider}` };
}
