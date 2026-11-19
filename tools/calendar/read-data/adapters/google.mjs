// tools/calendar/read-data/adapters/google.mjs
// The Google Calendar wire: the events of one calendar in a range (every occurrence of a repeating event, in start
// order), each read into the neutral event shape calendar-events.mjs makes blocks of.

export async function readEvents({ call }, { calendarId, rangeStart, rangeEnd, maxResults }) {
  const reply = await call('GET', `/calendars/${encodeURIComponent(calendarId ?? 'primary')}/events`, {
    query: { singleEvents: 'true', orderBy: 'startTime', maxResults, timeMin: rangeStart, timeMax: rangeEnd },
  });
  return (Array.isArray(reply?.items) ? reply.items : []).map(item => {
    const start = item?.start ?? {};
    const end = item?.end ?? {};
    return {
      id: item?.id || item?.iCalUID || item?.htmlLink,
      title: item?.summary,
      start: start.dateTime || start.date,
      end: end.dateTime || end.date,
      allDay: Boolean(start.date && !start.dateTime),
      timezone: start.timeZone || end.timeZone,
      cancelled: item?.status === 'cancelled',
      link: item?.htmlLink,
    };
  });
}
