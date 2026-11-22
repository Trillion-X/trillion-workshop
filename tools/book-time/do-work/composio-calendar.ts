// tools/book-time/do-work/composio-calendar.ts
//
// The Composio adapter for the calendar account: one Google Calendar that Composio holds for the person (connected through
// Composio, not the vault), reached by one Composio tool run per call. The calendar account names it as DATA with no secret in it:
// { provider: 'composio', toolkit: 'googlecalendar', account, user_id, project }. The Composio key is the held value
// composio-api-key, mounted on descriptor 5 by the tool row; accountOf in book-time.mjs adds it to the resolved connection as
// api_key, and nothing here prints, logs or returns it. Every failure is an answer with Composio's status, never a made-up success.
import type { BookingEventInput, ExternalCalendarEventResult, FetchLike } from './create-external-calendar-event.ts';
import type { ExternalBusyResult, ExternalChangeResult } from './external-calendar-busy-and-changes.ts';

export interface ComposioCalendarConnection {
  provider: 'composio';
  toolkit: 'googlecalendar';
  // the connected account's id (ca_...), as Composio lists it for the toolkit
  account: string;
  // the user id that owns the connected account (Composio needs it with the account)
  user_id: string;
  // the project the connections live in (pr_...); a user key (uak_) reaches them only with it named
  project: string;
  // resolved by the tool from composio-api-key; never stored in the account descriptor
  api_key: string;
}

const EXECUTE = 'https://backend.composio.dev/api/v3/tools/execute/';
const CALENDAR = 'primary';

// One Composio tool run for the connected account, as the person; resolves to the tool's data. A refusal names Composio's status only.
async function runTool(connection: ComposioCalendarConnection, slug: string, args: Record<string, unknown>, doFetch: FetchLike): Promise<any> {
  const key = connection.api_key;
  if (!key) throw new Error('composio-no-key');
  const headers = key.startsWith('uak_') ? { 'x-user-api-key': key, 'x-project-id': connection.project } : { 'x-api-key': key };
  const res = await doFetch(`${EXECUTE}${slug}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ connected_account_id: connection.account, user_id: connection.user_id, arguments: args }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`composio-${slug}-${res.status}`);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`composio-${slug}-no-json`); }
  if (parsed?.successful === false || parsed?.error) throw new Error(`composio-${slug}-unsuccessful: ${String(parsed.error ?? parsed.data?.message ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
  return parsed?.data?.response_data ?? parsed?.data ?? null;
}

export async function composioBusy(connection: ComposioCalendarConnection, fromMs: number, toMs: number, doFetch: FetchLike): Promise<ExternalBusyResult> {
  try {
    const data = await runTool(connection, 'GOOGLECALENDAR_FIND_FREE_SLOTS', {
      items: [CALENDAR],
      time_min: new Date(fromMs).toISOString(),
      time_max: new Date(toMs).toISOString(),
      timezone: 'UTC',
    }, doFetch);
    const calendar = data?.calendars?.[CALENDAR];
    if (!calendar || !Array.isArray(calendar.busy) || (Array.isArray(calendar.errors) && calendar.errors.length > 0)) {
      return { status: 'unknown', busy: [], error: 'calendar-not-readable' };
    }
    return { status: 'read', busy: calendar.busy.map((block: { start: string; end: string }) => ({ startMs: Date.parse(block.start), endMs: Date.parse(block.end) })) };
  } catch (error) {
    return { status: 'unknown', busy: [], error: (error as Error).message };
  }
}

export async function composioCreate(connection: ComposioCalendarConnection, booking: BookingEventInput, doFetch: FetchLike): Promise<ExternalCalendarEventResult> {
  try {
    const attendees = booking.attendees.map(person => person.email);
    const event = await runTool(connection, 'GOOGLECALENDAR_CREATE_EVENT', {
      summary: booking.title,
      ...(booking.description ? { description: booking.description } : {}),
      start_datetime: booking.start_local,
      end_datetime: booking.end_local,
      timezone: booking.timezone,
      attendees,
      create_meeting_room: booking.video_call !== undefined,
      send_updates: true,
    }, doFetch);
    if (!event?.id) return { status: 'error', error: 'composio-event-not-made' };
    const videoLink: string | undefined = event.hangoutLink ?? undefined;
    if (booking.video_call && !videoLink) return { status: 'error', external_event_id: event.id, error: 'video-call-not-made' };
    return { status: 'created', external_event_id: event.id, html_link: event.htmlLink, ...(videoLink ? { video_link: videoLink } : {}) };
  } catch (error) {
    return { status: 'error', error: (error as Error).message };
  }
}

export async function composioCancel(connection: ComposioCalendarConnection, eventId: string, doFetch: FetchLike): Promise<ExternalChangeResult> {
  try {
    await runTool(connection, 'GOOGLECALENDAR_DELETE_EVENT', { event_id: eventId, calendar_id: CALENDAR, send_updates: true }, doFetch);
    return { status: 'changed' };
  } catch (error) {
    return { status: 'error', error: (error as Error).message };
  }
}
