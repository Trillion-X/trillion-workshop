// tools/calendar/read-data/google-events.mjs
//
// Reading events from a Google calendar as time blocks: the request that asks for them, and the reading of what comes
// back. Both are plain functions of their input; the one place that sends is do-work/read-google-calendar-events.mjs,
// with the person's own credential. There is no clock here: the person names the range.

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_BASE = 'https://www.googleapis.com/calendar/v3/calendars/';
const OWNER = 'google-calendar';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Input problems, all of them, or an empty list. */
export function requestProblems(input) {
  if (!isRecord(input)) return ['Give { range_start, range_end } as ISO times.'];
  const problems = [];
  for (const name of ['range_start', 'range_end']) {
    if (typeof input[name] !== 'string' || Number.isNaN(Date.parse(input[name]))) problems.push(`${name} must be an ISO time`);
  }
  if (problems.length === 0 && Date.parse(input.range_end) <= Date.parse(input.range_start)) problems.push('range_end must be after range_start');
  if (input.calendar_id !== undefined && (typeof input.calendar_id !== 'string' || !input.calendar_id)) problems.push('calendar_id must be text');
  if (input.max_results !== undefined && !(Number.isInteger(input.max_results) && input.max_results >= 1 && input.max_results <= 2500)) problems.push('max_results must be a whole number from 1 to 2500');
  if (input.connection_ref !== undefined && typeof input.connection_ref !== 'string') problems.push('connection_ref must be text');
  return problems;
}

/** The events request: every occurrence of a repeating event, ordered by start, inside the range. */
export function eventsUrl(input) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(input.max_results ?? 50),
    timeMin: new Date(input.range_start).toISOString(),
    timeMax: new Date(input.range_end).toISOString(),
  });
  return `${EVENTS_BASE}${encodeURIComponent(input.calendar_id ?? 'primary')}/events?${params}`;
}

/** The answer's events as time blocks, and the issues worth showing (a refusal, or nothing in the range). */
export function readEvents(reply, { status, calendarId = 'primary', connectionRef } = {}) {
  const data = isRecord(reply) ? reply : {};
  const blocks = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    if (!isRecord(item)) continue;
    const start = isRecord(item.start) ? item.start : {};
    const end = isRecord(item.end) ? item.end : {};
    const from = start.dateTime || start.date;
    const to = end.dateTime || end.date || from;
    const eventId = item.id || item.iCalUID || item.htmlLink;
    if (!eventId || !from || !to) continue;
    blocks.push({
      id: `${OWNER}:${eventId}`,
      source: { lensId: 'events', inputAddress: `${OWNER}.${calendarId}.events`, ownerRef: OWNER, rowRef: String(eventId) },
      interval: { start: from, end: to, allDay: Boolean(start.date && !start.dateTime), timezone: start.timeZone || end.timeZone || 'local' },
      display: { title: item.summary || 'Untitled', color: '', ownerLabel: 'Google Calendar' },
      state: { ref: item.status === 'cancelled' ? 'cancelled' : 'ready', lane: OWNER },
      relations: {
        account: connectionRef ? [connectionRef] : [],
        list: [`${OWNER}:${calendarId}`],
        linkedRecord: item.htmlLink ? [item.htmlLink] : [],
        conflict: [],
      },
    });
  }
  const issues = [];
  if (!(status >= 200 && status < 300)) {
    const said = isRecord(data.error) && typeof data.error.message === 'string' ? data.error.message : null;
    issues.push({ id: 'sync-error', tone: 'error', label: 'Calendar could not sync.', detail: said || 'Google Calendar did not return events.' });
  } else if (blocks.length === 0) {
    issues.push({ id: 'sync-empty', tone: 'info', label: 'No events found.', detail: 'The account answered, but no events were returned for the range.' });
  }
  return { blocks, issues };
}
