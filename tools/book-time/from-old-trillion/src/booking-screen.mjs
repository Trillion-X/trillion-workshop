// The Book a session screen: a guide description (parts/ui/show/coss/guide.tsx draws it). It is the one place a
// session is picked, paid for, moved and cancelled; a link from an email (/book/<key>) opens this same screen with
// that key, so no other page draws booking controls.
import { lengthWords } from './booking.mjs';

const zoneOr = (zone, fallback) => {
  try { if (typeof zone === 'string' && zone) { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } } catch { /* an unknown zone reads as the host's */ }
  return fallback;
};
const zoneName = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(iso)).find(part => part.type === 'timeZoneName')?.value ?? zone;
const dayOf = (iso, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayWords = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso));
const clockWords = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
/** "Monday, October 5 at 9:00 AM PDT" in the viewer's zone. */
export const whenIn = (iso, zone) => `${dayWords(iso, zone)} at ${clockWords(iso, zone)} ${zoneName(iso, zone)}`;
const tokenOf = link => String(link).split('/book/').pop();
// A booking's own address on this screen: its key under /book/, which opens the move section for it.
const moveAddress = link => `/book/${tokenOf(link)}`;
const JUST_BOOKED_MS = 60 * 60 * 1000;

/** Open times as the time picker's days, each day and time in the viewer's zone. */
export function pickerDays(times, zone) {
  const days = new Map();
  for (const time of times) {
    const date = dayOf(time.start, zone);
    if (!days.has(date)) days.set(date, { date, label: dayWords(time.start, zone), options: [] });
    days.get(date).options.push({ value: time.start, label: clockWords(time.start, zone) });
  }
  return [...days.values()];
}

/** The offer as a card: its price in the option's own words (a recurring price's words say how often, as on the plan
 * cards), a single payment marked as one, and its benefits with their opening words in bold. */
export function offerCard(offer) {
  const option = offer.price_options?.[0];
  return {
    title: 'What you get',
    ...(option ? { price: option.label, ...(option.interval ? {} : { price_note: 'one payment' }) } : {}),
    features: offer.benefits ?? [],
  };
}

/** The section that moves one booking, opened by its key (bookingByKey's answer): its open times to move to, or, for a
 * cancelled one, that it is cancelled. Null when the key names no booking. */
function moveSection(moving, key, zone) {
  if (!moving) return null;
  if (moving.booking.state !== 'booked') return { heading: `Your session with ${moving.host} is cancelled`, body: 'Pick another time below, or see your other sessions here.' };
  const times = moving.times ?? [];
  return {
    heading: `Move your session with ${moving.host}`,
    body: `It is booked for ${whenIn(moving.booking.starts_at, zone)}. ${times.length ? 'Pick a new time.' : 'No other time is open in the next weeks.'}`,
    ...(times.length ? { choose: { name: 'start', label: 'Open times', days: pickerDays(times, zone), chosen: moving.booking.starts_at } } : {}),
    actions: [
      ...(times.length ? [{ label: 'Move to this time', tone: 'primary', full: true, busy_label: 'Moving…', send: { path: '/work/api/book/move', body: { token: key }, with_fields: true } }] : []),
      ...(moving.booking.video_link ? [{ label: 'Join the video call', tone: 'quiet', href: moving.booking.video_link }] : []),
      { label: 'Cancel', tone: 'quiet', send: { path: '/work/api/book/cancel', body: { token: key }, confirm: `Cancel the session with ${moving.host}?` } },
    ],
  };
}

/**
 * Book a session. `sessions`: bookingScreenFacts rows ({ row, offer, held, open, hosting }); `time_zone`: the viewer's
 * zone (the host's when unknown); `calendar_of(email)`: the viewer's own calendar connected in Trillion for that address,
 * or null; `now_ms`; `key` and `moving`: the key this screen was opened with (/book/<key>) and the booking it names
 * (bookingByKey), shown first with its move section. Every word about the session is the offer's and the bookable row's.
 */
export function bookSessionScreen({ sessions, time_zone: viewerZone = null, calendar_of: calendarOf = () => null, now_ms: nowMs = Date.now(), key = null, moving = null }) {
  const available = sessions.filter(item => item.offer || item.held.length || item.hosting);
  // Finish booking a paid session before showing another purchase. The other
  // offer's price and benefits otherwise read as the terms of this paid session.
  const unbookedPaidSession = available.some(item => item.held.some(grant => grant.sessions_left > 0));
  const shown = unbookedPaidSession
    ? available.filter(item => item.held.some(grant => grant.sessions_left > 0) || item.hosting?.length)
    : available;
  const moved = moveSection(moving, key, zoneOr(viewerZone, moving?.timezone ?? shown[0]?.row.rules.timezone ?? 'UTC'));
  if (!shown.length) return { title: 'Book a session', ...(moved ? {} : { lead: 'No session is offered right now.' }), sections: moved ? [moved] : [] };
  const zone = zoneOr(viewerZone, shown[0].row.rules.timezone);
  const sections = moved ? [moved] : [];
  let announce;
  for (const { row, offer, held, open, hosting } of shown) {
    if (hosting) sections.push({
      heading: 'Your upcoming sessions',
      rows: hosting.map(booking => ({
        id: `hosting-${booking.booking_id}`, title: booking.with ?? 'A guest', detail: whenIn(booking.starts_at, zone),
        actions: [
          ...(booking.video_link ? [{ label: 'Join the video call', tone: 'quiet', href: booking.video_link }] : []),
          { label: 'Move', tone: 'quiet', open: moveAddress(booking.change_or_cancel) },
          { label: 'Cancel', tone: 'quiet', send: { path: '/work/api/book/cancel', body: { token: tokenOf(booking.change_or_cancel) }, confirm: `Cancel the session with ${booking.with ?? 'this guest'}?` } },
        ],
      })),
      ...(hosting.length ? {} : { empty: { icon: 'CalendarClock', title: 'No sessions booked yet', body: 'When someone books a time with you, it shows here with the video call link.' } }),
    });
    const bookings = held.flatMap(grant => grant.bookings.map(booking => ({ ...booking, invited: grant.invited })));
    const left = held.find(grant => grant.sessions_left > 0);
    const owned = Boolean(left);
    if (offer && !owned && !bookings.length) sections.push({ offer: offerCard(offer) });
    for (const booking of bookings) {
      if (!announce && booking.booked_at && nowMs - Date.parse(booking.booked_at) < JUST_BOOKED_MS) announce = { id: booking.booking_id, text: 'Your session is booked' };
      const calendar = booking.invited ? calendarOf(booking.invited) : null;
      sections.push({
        heading: `Your session with ${row.host.name}`,
        rows: [{
          id: booking.booking_id, title: whenIn(booking.starts_at, zone), detail: row.session.place,
          status: { label: 'Booked', tone: 'good' },
          actions: [
            ...(booking.video_link ? [{ label: 'Join the video call', tone: 'primary', href: booking.video_link }] : []),
            { label: 'Move to another time', tone: 'quiet', open: moveAddress(booking.change_or_cancel) },
            { label: 'Cancel', tone: 'quiet', send: { path: '/work/api/book/cancel', body: { token: tokenOf(booking.change_or_cancel) }, confirm: 'Cancel this session? You can pick another time afterwards.' } },
          ],
        }],
        note: calendar ? `It is on your ${calendar} for ${booking.invited}.` : booking.invited ? `The invite is in ${booking.invited}: add it to your Google Calendar.` : undefined,
      });
    }
    if (!owned && !offer) continue;
    if (!owned && bookings.length) continue;
    const times = owned ? left.times ?? [] : open?.times ?? [];
    const note = owned ? left.note : open?.note;
    const picked = owned ? null : open?.picked ?? null;
    sections.push({
      heading: row.session.pick_heading ?? 'Pick a time',
      body: times.length ? `Times are in your time zone, ${zoneName(times[0].start, zone)}. Each session is ${lengthWords(row.rules.session_minutes)}.` : note ?? `No open times in the next weeks. Write to ${row.host.email} and ${row.host.name} will find one with you.`,
      ...(times.length ? { choose: { name: 'start', label: 'Open times', days: pickerDays(times, zone), ...(picked ? { chosen: picked.start } : {}) } } : {}),
      ...(times.length ? {
        actions: [owned
          ? { label: 'Book this time', tone: 'primary', full: true, busy_label: 'Booking…', send: { path: '/work/api/book/pick', body: { bookable_id: row.id }, with_fields: true } }
          : { label: 'Pay and book', tone: 'primary', full: true, busy_label: 'Opening secure checkout…', send: { path: '/work/api/book/pick', body: { bookable_id: row.id }, with_fields: true } }],
        footnote: owned ? row.session.held_note ?? 'Your session is included. Pick a time to book it.' : 'Nothing is charged until you confirm on Stripe\'s page. Your time is kept for you while you pay.',
      } : {}),
    });
  }
  // One session shown is named by its own title; the offer a person is shown a card for says what it is.
  // A paid session is the reason this person is here. An unrelated session's offer
  // must not become the headline for the whole screen.
  const hasPurchasedSession = shown.some(item => item.held.some(grant => grant.sessions_left > 0 || grant.bookings.length));
  const offer = hasPurchasedSession ? null : shown.find(item => item.offer)?.offer;
  return {
    title: shown.length === 1 ? shown[0].row.session.title : 'Book a session',
    ...(offer ? { lead: offer.summary } : {}),
    ...(announce ? { announce } : {}),
    sections,
  };
}
