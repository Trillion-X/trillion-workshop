// Availability records in the supplied record owner. Links, reservations,
// operations and interval holds all use the same record log/EEAF abstraction.

const LINK_TYPE = 'availability-link';
const RESERVATION_TYPE = 'availability-reservation';
const OPERATION_TYPE = 'availability-operation';
const HOLD_TYPE = 'availability-reservation-hold';
const LINK_PREFIX = `${LINK_TYPE}:`;
const RESERVATION_PREFIX = `${RESERVATION_TYPE}:`;
const OPERATION_PREFIX = `${OPERATION_TYPE}:`;
const HOLD_PREFIX = `${HOLD_TYPE}:`;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const INDEX_NAME = 'calendar-end';
const GRANT_INDEX = 'link-grant-held';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allStrings = (value, names) => isObject(value) && names.every(name => typeof value[name] === 'string' && value[name].trim());
const rootId = (prefix, id) => {
  if (typeof id !== 'string' || !id || id.includes('/')) throw new TypeError('Availability record ids must be nonempty record ids.');
  return `${prefix}${id}`;
};
const valueOf = (records, prefix, id) => records.read(rootId(prefix, id)) ?? null;

// Fixed-width sortable encoding keeps millisecond order in a string index.
function intervalKey(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError('Availability interval endpoints must be safe integer milliseconds.');
  return String(BigInt(value) + BigInt(MAX_SAFE)).padStart(17, '0');
}
const scopedIntervalKey = (calendarIdentity, value) => `${calendarIdentity}:${intervalKey(value)}`;

function calendarKey(calendar, identity) {
  if (!allStrings(calendar, ['source_id', 'connection_id', 'calendar_id', 'connected_at'])) {
    throw new TypeError('Availability calendar identity needs source, connection, calendar and connection-incarnation fields.');
  }
  const key = identity({ availability_calendar_incarnation: [calendar.source_id, calendar.connection_id, calendar.calendar_id, calendar.connected_at] });
  if (typeof key !== 'string' || !key) throw new TypeError('The injected BLAKE3 identity helper must return a nonempty string.');
  return key;
}
const sameCalendar = (left, right) => left?.source_id === right?.source_id
  && left?.connection_id === right?.connection_id
  && left?.calendar_id === right?.calendar_id
  && left?.connected_at === right?.connected_at;

const holdsTime = row => ['pending', 'booked'].includes(row.state) || (row.state === 'requested' && row.holds_slot === true);

function reservationRecord(row, identity) {
  if (!isObject(row) || typeof row.id !== 'string' || !row.id || !isObject(row.calendar)) {
    throw new TypeError('An availability reservation with its exact calendar incarnation is required.');
  }
  if (!['requested', 'pending', 'booked', 'cancelled', 'failed'].includes(row.state)
    || !(row.end_ms > row.start_ms)
    || !((row.occupied_end_ms ?? row.end_ms) > (row.occupied_start_ms ?? row.start_ms))
    || row.pending_start_ms != null && (!(row.pending_end_ms > row.pending_start_ms)
      || !((row.pending_occupied_end_ms ?? row.pending_end_ms) > (row.pending_occupied_start_ms ?? row.pending_start_ms)))) {
    throw new TypeError('Availability reservations need valid original and pending occupied intervals.');
  }
  const hostCalendars = row.host_calendars?.length ? row.host_calendars : [row.calendar];
  const pendingHostCalendars = row.pending_host_calendars?.length ? row.pending_host_calendars : hostCalendars;
  if (!Array.isArray(hostCalendars) || !hostCalendars.length || hostCalendars.length > 21
    || !Array.isArray(pendingHostCalendars) || !pendingHostCalendars.length || pendingHostCalendars.length > 21
    || !sameCalendar(hostCalendars[0], row.calendar) || !sameCalendar(pendingHostCalendars[0], row.calendar)) {
    throw new TypeError('Availability holds need bounded exact primary and co-host calendar identities.');
  }
  for (const calendar of [...hostCalendars, ...pendingHostCalendars]) calendarKey(calendar, identity);
  // Interval indexing belongs to the uniform derived holds below. Do not
  // retain per-position co-host index fields on the reservation as well.
  const stored = publicReservation(structuredClone(row));
  return stored;
}

function publicReservation(row) {
  if (!row) return null;
  const reservation = { ...row };
  for (const key of Object.keys(reservation)) {
    if (key === 'calendar_identity' || key === 'pending_calendar_identity'
      || /^(?:pending_)?(?:occupied_(?:start|end)_sort_key|cohost_\d+_(?:calendar_identity|occupied_(?:start|end)_sort_key)|pending_cohost_\d+_(?:calendar_identity|occupied_(?:start|end)_sort_key))$/.test(key)) delete reservation[key];
  }
  return reservation;
}

function holdRecords(row, identity) {
  const result = [];
  const addSet = (kind, calendars, start, end) => {
    calendars.forEach((calendar, index) => {
      const calendarIdentity = calendarKey(calendar, identity);
      const id = `${row.id}:${kind}:${index}`;
      result.push({ id: rootId(HOLD_PREFIX, id), type: HOLD_TYPE, value: {
        id, reservation_id: row.id, calendar, calendar_identity: calendarIdentity, interval_kind: kind,
        occupied_start_ms: start, occupied_end_ms: end,
        occupied_start_sort_key: scopedIntervalKey(calendarIdentity, start),
        occupied_end_sort_key: scopedIntervalKey(calendarIdentity, end), state: row.state, updated_at: row.updated_at,
      } });
    });
  };
  // A request holds its time only when the link said it should (`holds_slot`); booked and pending always hold.
  const active = holdsTime(row);
  const hostCalendars = row.host_calendars?.length ? row.host_calendars : [row.calendar];
  const pendingHostCalendars = row.pending_host_calendars?.length ? row.pending_host_calendars : hostCalendars;
  if (active) {
    addSet('current', hostCalendars, row.occupied_start_ms ?? row.start_ms, row.occupied_end_ms ?? row.end_ms);
    if (row.pending_start_ms != null) addSet('pending', pendingHostCalendars,
      row.pending_occupied_start_ms ?? row.pending_start_ms, row.pending_occupied_end_ms ?? row.pending_end_ms);
  }
  return result;
}

function priorHoldIds(row) {
  if (!row) return [];
  const hostCalendars = row.host_calendars?.length ? row.host_calendars : [row.calendar];
  const pendingHostCalendars = row.pending_host_calendars?.length ? row.pending_host_calendars : hostCalendars;
  return [...hostCalendars.map((_, index) => `${row.id}:current:${index}`),
    ...(row.pending_start_ms == null ? [] : pendingHostCalendars.map((_, index) => `${row.id}:pending:${index}`))];
}

/** Build availability storage over the supplied shared record owner. */
export function availabilityLinkEeafStore({ records: suppliedRecords, eeaf, transaction, identity, max_query_limit = 1000 } = {}) {
  const records = suppliedRecords ?? eeaf;
  if (!records || typeof records.read !== 'function' || typeof records.readMany !== 'function' || typeof records.write !== 'function'
    || typeof records.ids !== 'function' || typeof records.scan !== 'function' || typeof records.forgetCached !== 'function'
    || typeof transaction !== 'function' || typeof identity !== 'function') {
    throw new TypeError('Availability storage needs the shared record store, its transaction owner, and a BLAKE3 identity helper.');
  }
  if (!Number.isSafeInteger(max_query_limit) || max_query_limit < 1) throw new TypeError('max_query_limit must be a positive safe integer.');

  const write = (prefix, type, row) => {
    if (!isObject(row) || typeof row.id !== 'string' || !row.id) throw new TypeError('Availability records need a nonempty id.');
    records.write([{ id: rootId(prefix, row.id), type, value: structuredClone(row) }], { actor: { by: 'calendar-booker' } });
  };
  const listLinks = ({ after, limit = 25 } = {}) => {
    const take = Math.max(1, Math.min(max_query_limit, Number.isSafeInteger(limit) ? limit : 25));
    if (after !== undefined && (typeof after !== 'string' || !after)) throw new TypeError('The availability link cursor must be a nonempty link id.');
    const ids = records.ids(LINK_TYPE, { prefix: LINK_PREFIX,
      ...(after ? { before: rootId(LINK_PREFIX, after) } : {}), limit: take + 1 });
    const page = ids.slice(0, take).map(id => records.read(id)).filter(Boolean);
    return { links: page, next_cursor: ids.length > take && page.length ? page.at(-1).id : null };
  };

  const queryReservations = ({ calendar, calendars, from_ms, to_ms, limit } = {}) => {
    if (!Number.isSafeInteger(from_ms) || !Number.isSafeInteger(to_ms) || to_ms <= from_ms) {
      throw new TypeError('Availability reservation queries need a valid half-open millisecond interval.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Availability reservation query limit must be a positive safe integer.');
    const take = Math.min(limit, max_query_limit);
    const candidateCalendars = [calendar, ...(calendars ?? [])].filter((value, index, rows) => rows.findIndex(candidate => sameCalendar(candidate, value)) === index);
    if (candidateCalendars.length > 21) throw new TypeError('Availability reservation probes support at most 20 co-host calendars.');
    const candidates = [...new Set(candidateCalendars.map(value => calendarKey(value, identity)))];
    const reservationIds = new Set();
    let visited = 0;
    for (const calendarIdentity of candidates) {
      let cursor;
      while (true) {
        const pageLimit = Math.min(1000, max_query_limit - visited, take + 1);
        if (pageLimit < 1) return { reservations: [], complete: false };
        const options = { equal: [calendarIdentity], from: scopedIntervalKey(calendarIdentity, from_ms), limit: pageLimit };
        if (cursor) { options.after = cursor.value; options.after_id = cursor.id; }
        const page = records.scan(HOLD_TYPE, INDEX_NAME, options);
        if (!page.length) break;
        visited += page.length;
        const holds = page.map(entry => ({ id: entry.id, value: records.read(entry.id) })).filter(entry => entry.value);
        for (const { id, value } of holds) {
          if (candidateCalendars.some(calendar => sameCalendar(value.calendar, calendar))
            && value.occupied_end_ms > from_ms && value.occupied_start_ms < to_ms) reservationIds.add(value.reservation_id);
        }
        const last = page.at(-1);
        cursor = { id: last.id, value: last.values[1] };
        if (reservationIds.size > take || visited > max_query_limit) return { reservations: [], complete: false };
        if (page.length < pageLimit) break;
      }
    }
    const reservations = [...records.readMany([...reservationIds].map(id => rootId(RESERVATION_PREFIX, id))).values()].filter(Boolean);
    const exact = reservations.filter(holdsTime).filter(row => {
      const hostCalendars = row.host_calendars?.length ? row.host_calendars : [row.calendar];
      const pendingCalendars = row.pending_start_ms == null ? [] : (row.pending_host_calendars?.length ? row.pending_host_calendars : hostCalendars);
      return [...hostCalendars, ...pendingCalendars].some(host => candidateCalendars.some(candidate => sameCalendar(host, candidate)));
    }).filter(row => {
      const overlaps = (start, end) => start < to_ms && end > from_ms;
      return overlaps(row.occupied_start_ms ?? row.start_ms, row.occupied_end_ms ?? row.end_ms)
        || row.pending_start_ms != null && overlaps(row.pending_occupied_start_ms ?? row.pending_start_ms, row.pending_occupied_end_ms ?? row.pending_end_ms);
    }).map(publicReservation);
    return { reservations: exact, complete: true };
  };

  // Held (pending or booked) reservations under one share grant of one link, counted through their declared index; an
  // index still being built for older reservations cannot prove the count, so the read refuses rather than undercount.
  const countGrantReservations = ({ link_id, grant_ref, limit } = {}) => {
    if (typeof link_id !== 'string' || !link_id || typeof grant_ref !== 'string' || !grant_ref) throw new TypeError('Name the link and the share grant.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max_query_limit) throw new TypeError('The grant reservation count needs a bounded limit.');
    if (typeof records.indexReady === 'function' && !records.indexReady(RESERVATION_TYPE, GRANT_INDEX)) {
      throw Object.assign(new Error('Bookings made before this limit are still being counted. Try again shortly.'), { status: 503, code: 'grant-count-building' });
    }
    return records.scan(RESERVATION_TYPE, GRANT_INDEX, { equal: [link_id, grant_ref], limit }).length;
  };

  return Object.freeze({
    readLink: id => valueOf(records, LINK_PREFIX, id),
    writeLink: row => write(LINK_PREFIX, LINK_TYPE, row),
    listLinks,
    readReservation: id => publicReservation(valueOf(records, RESERVATION_PREFIX, id)),
    writeReservation: row => {
      const stored = reservationRecord(row, identity);
      const root = rootId(RESERVATION_PREFIX, row.id);
      const previous = records.read(root);
      const activeHolds = holdRecords(stored, identity);
      const activeIds = new Set(activeHolds.map(entry => entry.id));
      const released = priorHoldIds(previous).filter(id => !activeIds.has(rootId(HOLD_PREFIX, id))).map(id => {
        const existing = records.read(rootId(HOLD_PREFIX, id));
        return existing ? { id: rootId(HOLD_PREFIX, id), type: HOLD_TYPE,
          value: { ...existing, state: 'released', updated_at: stored.updated_at } } : null;
      }).filter(Boolean);
      records.write([{ id: root, type: RESERVATION_TYPE, value: stored }, ...activeHolds, ...released], { actor: { by: 'calendar-booker' } });
    },
    queryReservations,
    countGrantReservations,
    // One bounded page of a link's reservations in record-id order, through the by-link index its erasure cascade
    // already reads; `after` is the last record id of the page before. Each row is { record_id, reservation }.
    reservationsOfLink: ({ link_id, after = null, limit } = {}) => {
      if (typeof link_id !== 'string' || !link_id) throw new TypeError('Name the availability link.');
      if (after !== null && (typeof after !== 'string' || !after.startsWith(RESERVATION_PREFIX))) throw new TypeError('The reservation cursor is the last record id of a page.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > max_query_limit) throw new TypeError('A link reservation page needs a bounded limit.');
      const ids = records.scan(RESERVATION_TYPE, 'by-link', { equal: [link_id], ...(after ? { idFrom: `${after}\u0000` } : {}), limit }).map(entry => entry.id);
      const rows = records.readMany(ids);
      return { rows: ids.map(id => ({ record_id: id, reservation: rows.get(id) ?? null })), next: ids.length === limit ? ids.at(-1) : null };
    },
    reservationRecordId: id => rootId(RESERVATION_PREFIX, id),
    readOperation: id => valueOf(records, OPERATION_PREFIX, id),
    writeOperation: row => write(OPERATION_PREFIX, OPERATION_TYPE, row),
    transaction: change => {
      try { return transaction(change); }
      catch (error) { records.forgetCached(); throw error; }
    },
  });
}

export const availabilityLinkEeafRecordTypes = Object.freeze({ link: LINK_TYPE, reservation: RESERVATION_TYPE, operation: OPERATION_TYPE, hold: HOLD_TYPE });
