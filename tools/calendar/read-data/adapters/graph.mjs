// tools/calendar/read-data/adapters/graph.mjs
// The Microsoft Graph calendar wire: the calendar view of one calendar (or the default one) in a range, every
// occurrence of a repeating event, in start order, asked for in UTC, each read into the neutral event shape.

export async function readEvents({ call }, { calendarId, rangeStart, rangeEnd, maxResults }) {
  const path = calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/calendarView` : '/me/calendarView';
  const reply = await call('GET', path, {
    query: { startDateTime: rangeStart, endDateTime: rangeEnd, $top: maxResults, $orderby: 'start/dateTime' },
    headers: { Prefer: 'outlook.timezone="UTC"' },
  });
  const utc = value => (value && !/[zZ]|[+-]\d\d:\d\d$/.test(value) ? `${value}Z` : value);
  return (Array.isArray(reply?.value) ? reply.value : []).map(item => ({
    id: item?.id || item?.iCalUId,
    title: item?.subject,
    start: item?.isAllDay ? String(item?.start?.dateTime ?? '').slice(0, 10) : utc(item?.start?.dateTime),
    end: item?.isAllDay ? String(item?.end?.dateTime ?? '').slice(0, 10) : utc(item?.end?.dateTime),
    allDay: Boolean(item?.isAllDay),
    timezone: item?.isAllDay ? undefined : 'UTC',
    cancelled: Boolean(item?.isCancelled),
    link: item?.webLink,
  }));
}
