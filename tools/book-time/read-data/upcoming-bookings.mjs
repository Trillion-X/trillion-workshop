// tools/book-time/read-data/upcoming-bookings.mjs
//
// The host's upcoming bookings, read over the booking records the caller hands in (the tool keeps none).
// Ported from the old app's src/host-bookings.mjs (the "Your upcoming sessions" list, commit 7f492a4f68 parent state)
// and its test book-a-session.test.mjs.held:153,216: every upcoming session with who, when and the call link.
// The move and cancel actions are the tool's own; the caller picks them from the row.
//
// Invariants:
// - Only this host's bookings; a booking that is cancelled, no-show or completed is not upcoming.
// - Past starts are not upcoming; the list is in start order, earliest first.
// - A booking with no attendees or no call link still lists, with those fields empty, never dropped.

const LEFT = new Set(['cancelled', 'no_show', 'completed']);

export function upcomingBookings(bookings, { host, now }) {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new TypeError('now must be an ISO time');
  return (bookings ?? [])
    .filter(row => row.host_ref === host && !LEFT.has(row.status) && !row.cancelled_at)
    .filter(row => Date.parse(row.scheduled_start) >= nowMs)
    .sort((left, right) => Date.parse(left.scheduled_start) - Date.parse(right.scheduled_start))
    .map(row => ({
      id: row.id,
      when: row.scheduled_start,
      timezone: row.timezone ?? null,
      status: row.status,
      who: row.attendees ?? [],
      call: row.meeting_url ?? null,
    }));
}
