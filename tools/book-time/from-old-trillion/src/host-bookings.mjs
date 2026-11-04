// One host's bookings: grants (one per purchase of a bookable access) and bookings (src/booking.mjs BookingBook),
// the person's access checked before booking, the host's calendar read and written, every message sent, and the
// reminders woken for. src/booking-calendar.mjs is the Durable Object that runs one of these per host, so every
// booking for that host is written by one writer and no time is booked twice.
//
// A row whose host has connected their own calendar service (src/booking-service.mjs) books through it: open times,
// the booking, moving and cancelling are that service's, it sends its own confirmations, and each booking keeps the
// service's reference (`event_id`, route `service`) so a change made on the service's own pages is followed when the
// booking is next read. Any other row, and every booking made before, books by the row's own rules (openTimes) with the
// host's calendar connection or invitation file, exactly as before. A row whose sessions are video calls (`session.video_call`)
// books only where the call is made: the service's event type, or the calendar connection making it with the event;
// with neither, no time is offered and the person is told why (`note`).
import { BookingBook, BookingRefusal, bookableById, bookingView, messages, openTimes, timeView } from './booking.mjs';
import { calendarService } from './booking-service.mjs';
import reminderSettings from './booking-reminders.json' with { type: 'json' };

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMES_MS = 60 * 1000;
const MOVES_FOLLOWED = 5;
const overlaps = (a, b) => a.start_ms < b.end_ms && b.start_ms < a.end_ms;

// sql:      SQLite in the Durable Object's exec(...).toArray() shape
// transaction: fn → fn run as one transaction of that SQLite (the Durable Object's transactionSync)
// effects:  bookingEffects(env): mail, busy, place, move, cancel
// entitled: (row, grant) → whether the grant's person still holds the row's access
// runFor:   account spec → run(tool_id, input), the host's Workshop (src/booking-service.mjs hostToolRunner)
// rearm:    () → the calendar's alarm set again (src/scheduler.mjs), after a booking changes what reminders are ahead
export class HostBookings {
  // `later(promise)` keeps work running after the answer (the Durable Object's waitUntil): the messages a booking, move
  // or cancel sends go out after the person is answered, so pressing Book waits only for the calendar. Left out, they
  // are sent before answering.
  constructor({ sql, transaction = undefined, effects, entitled, runFor = () => async () => ({ connected: false }), rearm = async () => {}, now = () => Date.now(), token = undefined, later = null }) {
    this.book = new BookingBook(sql, { now, ...(token ? { token } : {}), ...(transaction ? { transaction } : {}) });
    Object.assign(this, { effects, entitled, runFor, rearm, now, later });
    this.services = new Map();
    this.timesSeen = new Map();
    this.busySeen = new Map();
  }

  row(id) {
    const row = bookableById(id);
    if (!row) throw new BookingRefusal(404, 'This session is not offered.');
    return row;
  }
  service(row) {
    if (!this.services.has(row.id)) this.services.set(row.id, calendarService(row, this.runFor(row.host.calendar_service?.account), { now: this.now }));
    return this.services.get(row.id);
  }
  /** How this row books now: through the host's calendar service, or by the row's own rules. */
  async way(row) {
    const service = this.service(row);
    const ready = service ? await service.ready() : { ready: false };
    return ready.ready ? { through: 'service', service, event_type_id: ready.event_type_id } : { through: 'rules', ...(ready.say ? { note: ready.say } : {}) };
  }
  /** Why a video-call session cannot be booked right now, in words for the person. */
  noCall(row, way, bought = true) {
    const next = `Write to ${row.host.email} and ${row.host.name} will find a time with you.`;
    return `${way.note ?? `${row.host.name}'s calendar is not connected yet, so the video call cannot be set up.`} ${next}`;
  }
  async busyFor(row) {
    const now = this.now();
    return this.effects.busy(row, now, now + ((row.rules.horizon_days ?? 28) + 1) * DAY_MS);
  }
  /** The host's busy times as shown to someone looking at open times: read at most once a minute, like a service's
   * times; booking or moving a time reads them fresh (busyFor). */
  lookedBusy(row) {
    const now = this.now();
    const seen = this.busySeen.get(row.id);
    if (seen && now - seen.at < TIMES_MS) return seen.busy;
    const busy = this.busyFor(row);
    this.busySeen.set(row.id, { at: now, busy });
    busy.then(
      result => { if (result.status !== 'read' && this.busySeen.get(row.id)?.busy === busy) this.busySeen.delete(row.id); },
      () => { if (this.busySeen.get(row.id)?.busy === busy) this.busySeen.delete(row.id); },
    );
    return busy;
  }
  /** Open times now, as { times, host_calendar, busy, note? }; `except` is a booking being moved, whose own time stays offered.
   * Through the host's service, times are that service's, less any time an earlier booking made by the rules holds. */
  async openNow(row, except = null, holder = null, { bought = true } = {}) {
    const way = await this.way(row);
    const now = this.now();
    if (way.through === 'service') {
      const seen = this.timesSeen.get(row.id);
      let times = seen && now - seen.at < TIMES_MS ? seen.times : null;
      if (!times) {
        try { times = await way.service.times(way.event_type_id, now, now + (row.rules.horizon_days ?? 28) * DAY_MS); }
        catch (error) { if (error instanceof BookingRefusal) return { times: [], host_calendar: 'unreadable', busy: [] }; throw error; }
        this.timesSeen.set(row.id, { at: now, times });
      }
      const ruled = [
        ...this.book.bookedOn(row.id, now).filter(item => item.route !== 'service' && item.id !== except).map(({ id, start_ms, end_ms }) => ({ id, start_ms, end_ms })),
        ...this.book.rows('SELECT person_ref, start_ms, end_ms FROM holds WHERE bookable_id = ? AND until_ms > ?', row.id, now).filter(item => item.person_ref !== holder),
      ];
      return { times: times.filter(time => !ruled.some(held => overlaps(time, held))), host_calendar: 'service', busy: [] };
    }
    const busy = await this.lookedBusy(row);
    // A video call is made only on a calendar this service can write, so with none there is no time to offer.
    if (row.session.video_call && busy.status !== 'read') return {
      times: [], host_calendar: busy.status === 'unreadable' ? 'unreadable' : 'not connected', busy: [],
      note: this.noCall(row, busy.status === 'unreadable' ? { ...way, note: `${row.host.name}'s calendar could not be read right now. Try again shortly.` } : way, bought),
    };
    return { times: openTimes(row, { nowMs: now, held: this.book.held(row.id, except, holder), busy: busy.busy }), host_calendar: busy.status === 'read' ? 'read' : 'not connected', busy: busy.busy, ...(way.note ? { note: way.note } : {}) };
  }
  /** A booking made through the host's service, brought up to date with it: cancelled there, moved there (the move's
   * new booking followed), or unchanged. One that cannot be read keeps what was last known. */
  async follow(row, booking) {
    if (booking.route !== 'service' || booking.state !== 'booked' || !booking.event_id) return booking;
    const service = this.service(row);
    if (!service) return booking;
    let held = await service.read(booking.event_id);
    for (let hops = 0; held?.cancelled && held.moved_to && hops < MOVES_FOLLOWED; hops += 1) held = await service.read(held.moved_to);
    if (!held) return booking;
    if (held.cancelled) return this.book.close(booking);
    const link = held.video_link ?? booking.video_link ?? null;
    if (held.ref !== booking.event_id || held.start_ms !== booking.start_ms || held.end_ms !== booking.end_ms || link !== (booking.video_link ?? null)) return this.book.moveTo(booking, held, held.ref, link);
    return booking;
  }
  async followAll(row, bookings) {
    const followed = [];
    for (const booking of bookings) followed.push(await this.follow(row, booking));
    return followed.filter(booking => booking.state === 'booked');
  }
  async send(row, list) {
    const results = [];
    for (const message of list) {
      if (!message.to?.filter(Boolean).length) continue;
      results.push({ to: message.to, subject: message.subject, ...(await this.effects.mail(row, message)) });
    }
    return results;
  }
  /** The messages a person's own change sends, after they are answered when `later` is given: each is listed as queued. */
  async sendAfterAnswer(row, list) {
    if (!this.later) return this.send(row, list);
    this.later(this.send(row, list).catch(error => console.error('booking messages could not be sent', error)));
    return list.filter(message => message.to?.filter(Boolean).length).map(message => ({ to: message.to, subject: message.subject, queued: true }));
  }
  /** When the next reminder is due (epoch ms), or null: the calendar's alarm source (src/booking-calendar.mjs). */
  nextReminderAt() { return this.book.nextReminderAt(); }
  refusal(error) {
    if (error instanceof BookingRefusal) return { refused: { status: error.status, message: error.message } };
    throw error;
  }
  // The grant a request books under: its token (from the email link), or the person's first grant with a session left.
  grantFor({ grant_token: token, person_ref: personRef, bookable_id: bookableId }) {
    if (token) return this.book.grantByToken(token);
    const grants = this.book.grantsFor(personRef).filter(grant => !bookableId || grant.bookable_id === bookableId);
    return grants.find(grant => this.book.left(grant) > 0) ?? grants[0] ?? null;
  }

  /** A purchase landed: make its grant once. The first time, the time the buyer picked before paying is booked when it
   * is still open (the booking's own messages go out); otherwise the buyer gets their link and the host is told. */
  async grantFromPurchase({ bookable_id: bookableId, key, person_ref: personRef, email, name = null, offer, contract = null, period = null, origin }) {
    const row = this.row(bookableId);
    const { grant, created } = this.book.grant({ key, bookable_id: bookableId, person_ref: personRef, email, name, offer_id: offer?.id ?? null, contract, period });
    if (this.book.left(grant) === 0) return { created, sent: [] };
    const picked = personRef && !this.book.bookingsOf(grant.key).length ? this.book.holdOf(row.id, personRef) : null;
    if (picked) {
      const made = await this.bookTime({ grant_token: grant.token, start: new Date(picked.start_ms).toISOString(), origin });
      this.book.letGo(row.id, personRef);
      if (made.booked) {
        // The booking's own confirmation replaces both purchase notices, including after a later cancellation.
        this.book.notified(grant.key, 'buyer');
        this.book.notified(grant.key, 'host');
        return { created, booked: made.booked, sent: made.sent };
      }
    }
    // A row included with an offer that sells something else (`session.included`) is booked from Book a session, unannounced.
    if (row.session.included) return { created, sent: [] };
    const latest = this.book.grantByKey(grant.key);
    const notices = messages.bought({ row, grant, origin, offer });
    const sent = [];
    for (const [index, who] of ['buyer', 'host'].entries()) {
      if (latest[`${who}_notified_at`]) continue;
      if (!notices[index].to?.filter(Boolean).length) continue;
      const result = { to: notices[index].to, subject: notices[index].subject, ...(await this.effects.mail(row, notices[index])) };
      // The credit is already saved. An email outage must not undo an accepted contract or settled payment;
      // leaving this timestamp empty lets a repeated purchase notice retry just this recipient.
      if (result.sent) this.book.notified(grant.key, who);
      sent.push(result);
    }
    return { created, sent };
  }

  /** Keeps an open time for a person while they pay (`rules.hold_minutes`); picking another lets the first go. */
  async hold({ bookable_id: bookableId, person_ref: personRef, start }) {
    try {
      const row = this.row(bookableId);
      if (!personRef) throw new BookingRefusal(403, 'Sign in to pick a time.');
      const startMs = Date.parse(start);
      if (!Number.isFinite(startMs)) throw new BookingRefusal(400, 'Pick a time from the open times.');
      const time = (await this.openNow(row, null, personRef)).times.find(item => item.start_ms === startMs);
      if (!time) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another.');
      const kept = this.book.hold(row, personRef, time);
      return { held: { ...timeView(row, time), until: new Date(kept.until_ms).toISOString() } };
    } catch (error) { return this.refusal(error); }
  }

  /** Whether a person picked a time or bought a session here since `since_ms` (where to send them back after paying). */
  recent({ person_ref: personRef, since_ms: sinceMs }) {
    const since = new Date(sinceMs).toISOString();
    if (this.book.rows('SELECT 1 FROM holds WHERE person_ref = ? AND created_at >= ?', personRef, since).length > 0) return true;
    // A session included with a plan (a free call with a membership) is booked whenever the person wants, so buying the
    // plan opens that plan's own welcome, not Book a session.
    return this.book.grantsFor(personRef).filter(grant => grant.created_at >= since)
      .some(grant => !bookableById(grant.bookable_id)?.session?.included);
  }

  /** Every upcoming session for the host of `bookable_ids`: who, when, the call link and the session's own change link. */
  async upcoming({ bookable_ids: bookableIds, origin }) {
    const out = [];
    for (const id of bookableIds) {
      const row = this.row(id);
      const booked = this.book.bookedOn(id, this.now());
      for (const booking of await this.followAll(row, booked)) out.push({ ...bookingView(row, booking, origin), with: booking.customer_name ?? booking.email ?? null });
    }
    return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }
  /** A purchase from before booking existed: its grant, made quietly. */
  ensureGrant({ bookable_id: bookableId, key, person_ref: personRef, email, name = null, offer_id: offerId, contract = null, period = null }) {
    this.book.grant({ key, bookable_id: bookableId, person_ref: personRef, email, name, offer_id: offerId, contract, period });
    return true;
  }

  /** What a person (by grant token or by their store) holds here, with open times when asked. */
  async state({ grant_token: token = null, person_ref: personRef = null, bookable_id: bookableId = null, origin, with_times: withTimes = false }) {
    const grants = token ? [this.book.grantByToken(token)].filter(Boolean) : this.book.grantsFor(personRef).filter(grant => !bookableId || grant.bookable_id === bookableId);
    if (token && !grants.length) return { refused: { status: 404, message: 'This booking link is not valid. Use the newest link from your email, or open your account.' } };
    const out = [];
    for (const grant of grants) {
      const row = this.row(grant.bookable_id);
      if (token && !(await this.entitled(row, grant))) return { refused: { status: 403, message: 'This purchase is no longer active, so this booking link cannot be used.' } };
      const bookings = (await this.followAll(row, this.book.bookingsOf(grant.key))).map(booking => bookingView(row, booking, origin));
      const left = this.book.left(grant);
      // key, person_ref and the billing period name the purchase that made the grant, so the caller can count it only
      // while that purchase is active (src/booking.mjs grantHeldByActivePurchase).
      const entry = { bookable_id: row.id, title: row.session.title, host: row.host.name, timezone: row.rules.timezone, grant_token: grant.token, key: grant.key, person_ref: grant.person_ref ?? null, series_key: grant.series_key ?? null, period_start: grant.period_start ?? null, period_end: grant.period_end ?? null, sessions_left: left, bookings, invited: grant.email ?? null };
      if (withTimes && left > 0) {
        const open = await this.openNow(row, null, grant.person_ref);
        entry.host_calendar = open.host_calendar;
        entry.times = open.times.map(time => timeView(row, time));
        if (open.note) entry.note = open.note;
      }
      out.push(entry);
    }
    return { grants: out };
  }

  /** Open times for a bookable, for anyone (no grant needed to look); with `person_ref`, the time that person is paying
   * for stays among them and is named as `picked`. */
  async times({ bookable_id: bookableId, person_ref: personRef = null }) {
    const row = this.row(bookableId);
    // Anyone may look, before buying: a note says what to do without a purchase to reply to.
    const open = await this.openNow(row, null, personRef, { bought: false });
    const picked = personRef ? this.book.holdOf(row.id, personRef) : null;
    return {
      bookable_id: row.id, timezone: row.rules.timezone, host_calendar: open.host_calendar, times: open.times.map(time => timeView(row, time)),
      ...(picked && picked.until_ms > this.now() && open.times.some(time => time.start_ms === picked.start_ms) ? { picked: timeView(row, picked) } : {}),
      ...(open.note ? { note: open.note } : {}),
    };
  }

  /** Books a time under a grant, puts it on the host's calendar, and tells both people. `name` and `time_zone` are the
   * buyer's, for a calendar service that asks for them (the purchase email and the host's zone otherwise). */
  async bookTime({ grant_token: token = null, person_ref: personRef = null, bookable_id: bookableId = null, start, case_id: caseId = null, name = null, time_zone: timeZone = null, origin }) {
    try {
      let grant = this.grantFor({ grant_token: token, person_ref: personRef, bookable_id: bookableId });
      if (!token && personRef && grant && !(await this.entitled(this.row(grant.bookable_id), grant))) {
        for (const candidate of this.book.grantsFor(personRef)) {
          if (bookableId && candidate.bookable_id !== bookableId) continue;
          if (this.book.left(candidate) > 0 && await this.entitled(this.row(candidate.bookable_id), candidate)) { grant = candidate; break; }
        }
      }
      if (!grant) throw new BookingRefusal(403, 'Booking this session needs its purchase first. Buy it, then pick a time.');
      const row = this.row(grant.bookable_id);
      if (!(await this.entitled(row, grant))) throw new BookingRefusal(403, 'This purchase is no longer active, so no time can be booked with it.');
      const startMs = Date.parse(start);
      if (!Number.isFinite(startMs)) throw new BookingRefusal(400, 'Give the start time from the open times list.');
      const way = await this.way(row);
      if (way.through === 'service' && grant.email) {
        this.book.hasLeft(grant);
        const open = await this.openNow(row, null, grant.person_ref);
        if (!open.times.some(time => time.start_ms === startMs)) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another from the open times.');
        const made = await way.service.book(way.event_type_id, {
          start_ms: startMs, name: typeof name === 'string' && name.trim() ? name.trim() : grant.email, email: grant.email,
          time_zone: typeof timeZone === 'string' && timeZone ? timeZone : row.rules.timezone, notes: caseId ? { decision: String(caseId) } : null,
        });
        this.timesSeen.delete(row.id);
        // The call's link, from the booking reply or, when the service adds it just after, from reading the booking once.
        const videoLink = made.video_link ?? (row.session.video_call ? (await way.service.read(made.ref))?.video_link : null) ?? null;
        const booking = this.book.record({ grant, time: made, case_id: caseId, event_id: made.ref, route: 'service', video_link: videoLink });
        await this.rearm();
        return { booked: bookingView(row, booking, origin), sent: [] };
      }
      // A calendar service needs an email for its attendee. A signed-in buyer without one can still take a time
      // the service offered: the host's calendar creates the call, while the booking stays in this account.
      let booking;
      if (way.through === 'service') {
        const time = (await this.openNow(row, null, grant.person_ref)).times.find(item => item.start_ms === startMs);
        if (!time) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another from the open times.');
        booking = this.book.record({ grant, time, case_id: caseId });
      } else {
        const busy = await this.busyFor(row);
        booking = this.book.book({ grant, start_ms: startMs, busy: busy.busy, case_id: caseId });
      }
      let placed;
      try {
        placed = await this.effects.place(row, booking, this.now());
      } catch (error) {
        this.book.close(booking);
        throw new BookingRefusal(503, `The session could not be added to ${row.host.name}'s calendar right now. Pick a time again shortly.`);
      }
      if (!placed.route) {
        this.book.close(booking);
        throw new BookingRefusal(503, placed.connected === false
          ? this.noCall(row, way)
          : `${row.host.name}'s calendar could not make the video call right now. Pick a time again shortly.`);
      }
      this.book.placed(booking.id, placed);
      const kept = this.book.bookingById(booking.id);
      const sent = await this.sendAfterAnswer(row, messages.booked({ row, booking: kept, origin, placed }));
      await this.rearm();
      return { booked: bookingView(row, kept, origin), sent };
    } catch (error) { return this.refusal(error); }
  }

  /** Moves or cancels a booking by its own link's token. */
  async change({ booking_token: token, start = null, cancel = false, origin }) {
    try {
      const found = this.book.bookingByToken(token);
      if (!found) throw new BookingRefusal(404, 'This link is not valid. Use the newest link from your email.');
      const row = this.row(found.bookable_id);
      const booking = await this.follow(row, found);
      const grant = this.book.grantByKey(booking.grant_key);
      const bookAgain = grant ? `${origin}/book/${grant.token}` : null;
      const startMs = cancel ? null : Date.parse(start);
      if (!cancel && !Number.isFinite(startMs)) throw new BookingRefusal(400, 'Give the new start time from the open times list.');
      if (booking.route === 'service') {
        const service = this.service(row);
        if (!service) throw new BookingRefusal(409, `This session is on ${row.host.name}'s calendar, which cannot be reached from here any more. Reply to your booking email to change it.`);
        this.book.changeable(row, booking);
        if (cancel) {
          await service.cancel(booking.event_id);
          this.book.close(booking);
          this.timesSeen.delete(row.id);
          return { cancelled: true, book_again: bookAgain, sent: [] };
        }
        const open = await this.openNow(row, booking.id);
        if (!open.times.some(time => time.start_ms === startMs)) throw new BookingRefusal(409, 'That time was just taken or is no longer open. Pick another from the open times.');
        const moved = await service.move(booking.event_id, startMs);
        this.timesSeen.delete(row.id);
        const updated = this.book.moveTo(booking, moved, moved.ref, moved.video_link ?? booking.video_link ?? null);
        await this.rearm();
        return { moved: bookingView(row, updated, origin), sent: [] };
      }
      if (cancel) {
        const cancelled = this.book.cancel(booking);
        const placed = await this.effects.cancel(row, cancelled, this.now());
        const sent = await this.sendAfterAnswer(row, messages.cancelled({ row, booking: { ...cancelled, grant_token: grant?.token }, origin, placed }));
        return { cancelled: true, book_again: bookAgain, sent };
      }
      const busy = await this.busyFor(row);
      const moved = this.book.move(booking, startMs, busy.busy);
      const placed = await this.effects.move(row, moved, this.now());
      // A video call lives on the calendar event; one the calendar could not move stays at its time.
      if (row.session.video_call && placed.route !== 'calendar') {
        this.book.moveTo(moved, booking);
        throw new BookingRefusal(503, `The session could not be moved on ${row.host.name}'s calendar right now. Try again shortly, or reply to your booking email.`);
      }
      this.book.placed(moved.id, placed);
      const sent = await this.sendAfterAnswer(row, messages.moved({ row, booking: moved, origin, placed }));
      await this.rearm();
      return { moved: bookingView(row, { ...moved, route: placed.route }, origin), sent };
    } catch (error) { return this.refusal(error); }
  }

  /** One booking by its own token, with the times it could move to. */
  async bookingPage({ booking_token: token, origin }) {
    const found = this.book.bookingByToken(token);
    if (!found) return null;
    const row = this.row(found.bookable_id);
    const booking = await this.follow(row, found);
    const times = booking.state === 'booked' ? (await this.openNow(row, booking.id)).times.map(time => timeView(row, time)) : [];
    return { booking: { ...bookingView(row, booking, origin), state: booking.state }, title: row.session.title, host: row.host.name, timezone: row.rules.timezone, times };
  }

  /** Sends every reminder that is due; a message the mail refused is tried again later, to whoever it did not reach (src/booking-reminders.json). The calendar's alarm then wakes for the next one. */
  async remind(origin) {
    for (const due of this.book.dueReminders()) {
      const row = bookableById(due.bookable_id);
      const reached = new Set(JSON.parse(due.sent_to ?? '[]'));
      let refused = false;
      if (row) {
        for (const message of messages.reminder({ row, booking: due, origin })) {
          const to = (message.to ?? []).filter(Boolean);
          if (!to.length || to.every(address => reached.has(address))) continue;
          const answer = await this.effects.mail(row, message);
          if (answer.sent || answer.unknown) to.forEach(address => reached.add(address));
          else refused = true;
        }
      }
      if (!refused) { this.book.reminded(due.booking_id, due.minutes_before); continue; }
      const tries = due.tries + 1;
      this.book.retried(due.booking_id, due.minutes_before, { sentTo: [...reached], tries, dueMs: this.now() + reminderSettings.retry_after_minutes * 60 * 1000 });
      if (tries >= reminderSettings.most_tries) this.book.reminded(due.booking_id, due.minutes_before);
    }
  }

  /** A person deleting their account: upcoming sessions are cancelled (both told) and their email forgotten. */
  async forget({ person_ref: personRef, origin }) {
    let cancelled = 0;
    for (const booking of this.book.bookingsFor(personRef).filter(item => item.start_ms > this.now())) {
      const row = this.row(booking.bookable_id);
      if (booking.route === 'service') {
        await this.service(row)?.cancel(booking.event_id).catch(() => null);
        this.book.close(booking);
      } else {
        const done = this.book.close(booking);
        const placed = await this.effects.cancel(row, done, this.now());
        await this.send(row, messages.cancelled({ row, booking: { ...done, grant_token: null }, origin, placed }).slice(1));
      }
      cancelled += 1;
    }
    this.book.forget(personRef);
    return { cancelled };
  }
}
