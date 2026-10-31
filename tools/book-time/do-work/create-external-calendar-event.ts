// tools/book-time/do-work/create-external-calendar-event.ts
//
// The generic capability that turns a confirmed booking into a real event on the host's EXTERNAL
// calendar (Google Calendar today, any provider tomorrow, because the provider is DATA, see below).
// The event-creation orchestration. It does not own the external credential: it is given an already-resolved
// connection (the person's own calendar account, handed on a private pipe by the run) and performs the outbound
// write through an injected transport. It never reads a vault directly.
//
// Provider-agnostic by DATA (L069/L090): `provider` selects one wire adapter. Google is the seed and
// required proof case. Adding Outlook/CalDAV/etc. is a new adapter entry plus a DATA row, never a change
// to callers. The one named example (Google) expands to the whole external-calendar category.

export type ExternalCalendarProvider = 'google';

// The resolved connection a credential mount hands this capability. For Google this is an OAuth
// client plus an offline refresh token for the host's calendar account (a person's own calendar account). The
// bytes come from a held value. This module is blind to how they were stored or revealed.
export interface GoogleCalendarConnection {
  provider: 'google';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  // target calendar. 'primary' is the refresh-token owner's calendar. May be a calendar address.
  calendar_id?: string;
}

export type ExternalCalendarConnection = GoogleCalendarConnection;

// The booking, in the package's own booking terms (not a caller's internal shape).
export interface BookingEventInput {
  title: string;
  description?: string;
  // wall-clock start/end "YYYY-MM-DDTHH:MM(:SS)" expressed in `timezone`.
  start_local: string;
  end_local: string;
  timezone: string; // IANA
  attendees: { email: string; displayName?: string }[];
  // where it happens, in words or an address. Optional.
  location?: string;
  // minutes before the start at which the calendar reminds people. Optional; the defaults below otherwise.
  reminder_minutes?: number[];
  // a video call made with the event, its link on the invite. `request_id` names this one request, so a retried
  // create asks for the same call. The provider's own video service is used (Google Meet for Google).
  video_call?: { request_id: string };
}

export interface ExternalCalendarEventResult {
  status: 'created' | 'error';
  external_event_id?: string;
  html_link?: string;
  // the video call's join link, when the booking asked for one and the provider made it.
  video_link?: string;
  error?: string;
}

// Injected transport so the capability stays testable and decoupled. The tool passes fetch, tests pass a fake. Defaults to global fetch for direct/offline use.
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

function normalizeLocal(value: string): string {
  return /T\d{2}:\d{2}:\d{2}$/.test(value) ? value : `${value}:00`;
}

export async function mintGoogleAccessToken(conn: GoogleCalendarConnection, doFetch: FetchLike): Promise<string | null> {
  const res = await doFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: conn.client_id,
      client_secret: conn.client_secret,
      refresh_token: conn.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function createGoogleEvent(
  conn: GoogleCalendarConnection,
  booking: BookingEventInput,
  doFetch: FetchLike,
): Promise<ExternalCalendarEventResult> {
  const accessToken = await mintGoogleAccessToken(conn, doFetch);
  if (!accessToken) return { status: 'error', error: 'token-refresh-failed' };

  const calendarId = conn.calendar_id || 'primary';
  const body = {
    summary: booking.title,
    description: booking.description ?? '',
    ...(booking.location ? { location: booking.location } : {}),
    start: { dateTime: normalizeLocal(booking.start_local), timeZone: booking.timezone },
    end: { dateTime: normalizeLocal(booking.end_local), timeZone: booking.timezone },
    attendees: booking.attendees.map((a) => ({ email: a.email, displayName: a.displayName })),
    reminders: {
      useDefault: false,
      overrides: booking.reminder_minutes?.length
        ? booking.reminder_minutes.map((minutes) => ({ method: 'email', minutes }))
        : [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 10 },
        ],
    },
    ...(booking.video_call ? { conferenceData: { createRequest: { requestId: booking.video_call.request_id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };

  // conferenceDataVersion=1 is what makes Google read conferenceData and make the Meet call.
  const res = await doFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all${booking.video_call ? '&conferenceDataVersion=1' : ''}`,
    { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const detail = await res.text();
    return { status: 'error', error: `insert-${res.status}:${detail.slice(0, 160)}` };
  }
  const data = (await res.json()) as { id?: string; htmlLink?: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
  const videoLink = data.hangoutLink ?? data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri;
  if (booking.video_call && !videoLink) return { status: 'error', external_event_id: data.id, error: 'video-call-not-made' };
  return { status: 'created', external_event_id: data.id, html_link: data.htmlLink, ...(videoLink ? { video_link: videoLink } : {}) };
}

// The single generic entrypoint. `provider` is DATA. The adapter map is the only place a provider name
// binds to a wire, so a new provider is one map entry, never a caller change (enum-dissolution).
export async function createExternalCalendarEvent(
  connection: ExternalCalendarConnection,
  booking: BookingEventInput,
  doFetch: FetchLike = fetch as unknown as FetchLike,
): Promise<ExternalCalendarEventResult> {
  const adapters: Record<ExternalCalendarProvider, (c: ExternalCalendarConnection, b: BookingEventInput, f: FetchLike) => Promise<ExternalCalendarEventResult>> = {
    google: (c, b, f) => createGoogleEvent(c as GoogleCalendarConnection, b, f),
  };
  const adapter = adapters[connection.provider];
  if (!adapter) return { status: 'error', error: `unsupported-provider:${connection.provider}` };
  return adapter(connection, booking, doFetch);
}
