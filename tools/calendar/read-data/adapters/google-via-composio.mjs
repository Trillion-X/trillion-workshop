// tools/calendar/read-data/adapters/google-via-composio.mjs
// The Google Calendar events through Composio's own GOOGLECALENDAR tool: one execute call for the events of one calendar in a
// range (every occurrence of a repeating event, in start order), read into the same neutral event shape as the Google wire
// (adapters/google.mjs eventOf, whose API shape Composio returns in its data).

import { eventOf } from './google.mjs';

export async function readEvents({ execute, accountId, userId, projectId }, { calendarId, rangeStart, rangeEnd, maxResults }) {
  const data = await execute('GOOGLECALENDAR_EVENTS_LIST', accountId, {
    calendarId: calendarId ?? 'primary',
    timeMin: rangeStart,
    timeMax: rangeEnd,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults,
  }, userId, projectId);
  return (Array.isArray(data?.items) ? data.items : []).map(eventOf);
}
