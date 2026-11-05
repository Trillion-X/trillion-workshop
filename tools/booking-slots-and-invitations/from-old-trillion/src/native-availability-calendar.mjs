// Native adapter for personal availability links. Calendar selection, account
// incarnation, provider tools and action policy all come from the current
// Calendar owner and its DATA; mutations stay inside Workshop's effect ledger.
import calendarSettings from '../../../keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/calendar.json' with { type: 'json' };
import { prepareCalendarAction } from '../../../keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/calendar-actions.mjs';
import { workshopTaskId, canonical } from '../../../keep-and-wake-ai-sessions-on-this-computer/src/typed-operation-contract.mjs';
import { zonedWallClockToUtcMs } from '../../do-work/derive-open-slots.ts';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const atPath = (value, path) => Array.isArray(path) && path.length ? path.reduce((current, key) => current?.[key], value) : undefined;
const firstPath = (value, paths) => (paths ?? []).map(path => atPath(value, path)).find(item => item !== undefined && item !== null);
const fill = (value, replacements) => {
  if (Array.isArray(value)) return value.map(item => fill(item, replacements));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, replacements)]));
  return typeof value === 'string' && Object.hasOwn(replacements, value) ? replacements[value] : value;
};
const interval = (row, calendarZone) => {
  const starts = row?.starts_at ?? row?.start, ends = row?.ends_at ?? row?.end;
  const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const allDay = dateOnly(starts) || dateOnly(ends);
  if (allDay && (!dateOnly(starts) || !dateOnly(ends) || !nonempty(calendarZone))) return null;
  let start, end;
  try {
    start = allDay ? zonedWallClockToUtcMs(starts, 0, calendarZone) : Date.parse(starts);
    end = allDay ? zonedWallClockToUtcMs(ends, 0, calendarZone) : Date.parse(ends);
  } catch { return null; }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { startMs: start, endMs: end } : null;
};
const calendarOf = row => object(row?.calendar) ? row.calendar : row;
const iso = value => new Date(value).toISOString();
const validInviteEmail = value => nonempty(value) && value.trim().length <= 254
  && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const normalizedEmail = value => validInviteEmail(value) ? value.trim().toLowerCase() : null;
const normalizedTime = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const sameSelection = (source, selection) => source?.selection?.source_id === selection.source_id
  && source.selection.connection_id === selection.connection_id
  && source.selection.connected_at === selection.connected_at
  && source.selection.calendar_id === selection.calendar_id;
const sameCalendar = (left, right) => object(left) && object(right)
  && ['source_id', 'connection_id', 'connected_at', 'calendar_id'].every(key => left[key] === right[key]);

function selectionsFor(link) {
  const calendars = [calendarOf(link), ...(Array.isArray(link?.cohosts) ? link.cohosts.map(calendarOf) : [])];
  if (!calendars.length || calendars.some(calendar => !object(calendar)
    || !['source_id', 'connection_id', 'calendar_id', 'connected_at'].every(key => nonempty(calendar[key])))) {
    throw new TypeError('Availability calendars need their exact source, account, calendar and connection incarnation.');
  }
  const seen = new Set();
  for (const calendar of calendars) {
    const key = [calendar.source_id, calendar.connection_id, calendar.calendar_id, calendar.connected_at].join('\u0000');
    if (seen.has(key)) throw new TypeError('An availability link cannot select the same calendar twice.');
    seen.add(key);
  }
  return calendars;
}

const invalidSelection = (code, message) => Object.assign(new Error(message), { status: 409, read_status: 'invalid-selection', code });

function effectTaskResult(task, { needsEvent = false } = {}) {
  if (!task || typeof task !== 'object') return { state: 'unknown', error: 'workshop-result-missing' };
  const message = String(task.error ?? task.message ?? '');
  if (task.effect?.state === 'unknown' || task.effect?.state === 'dispatching'
    || /may have happened|no answer came back|not sent again/i.test(message)) {
    return { state: 'unknown', ...(message ? { error: message } : {}) };
  }
  if (task.connected === false || task.missing_connection || task.state === 'refused'
    || task.effect?.state === 'rejected') {
    return { state: 'refused', error: message || 'calendar-capability-unavailable' };
  }
  if (task.state === 'completed') {
    const id = task.output?.id ?? task.output?.event_id ?? task.output?.provider_id;
    if (needsEvent && !nonempty(id)) return { state: 'unknown', error: 'calendar-event-identity-unconfirmed' };
    return { state: 'completed', ...(nonempty(id) ? { external_event_id: id } : {}) };
  }
  if (task.effect?.state === 'unknown' || task.effect?.state === 'dispatching'
    || /may have happened|no answer came back|not sent again/i.test(message)) {
    return { state: 'unknown', ...(message ? { error: message } : {}) };
  }
  if (task.state === 'failed') return { state: 'failed', ...(message ? { error: message } : {}) };
  return { state: 'pending', ...(message ? { error: message } : {}) };
}

/**
 * Adapt an admitted native Calendar owner to the AvailabilityLinkOwner
 * `readBusy` and `effects` contracts. Reads rediscover and validate the exact
 * source selection; effect recovery retries only an unbound frozen operation,
 * then snapshots its durable original task.
 */
export function createNativeAvailabilityCalendar({ calendarOwner, workshop, settings = calendarSettings, readEffectBinding, keepEffectBinding, maxBusyRows = 3000 } = {}) {
  if (!Number.isSafeInteger(maxBusyRows) || maxBusyRows < 1) throw new TypeError('A positive bounded Calendar busy-read budget is required.');
  if (!calendarOwner || typeof calendarOwner.invoke !== 'function') throw new TypeError('The current native Calendar owner is required.');
  if (!workshop || typeof workshop.run !== 'function' || typeof workshop.snapshot !== 'function') {
    throw new TypeError('The current native Workshop run and snapshot owners are required.');
  }
  if (typeof readEffectBinding !== 'function' || typeof keepEffectBinding !== 'function') throw new TypeError('The original operation needs its durable Workshop binding owner.');

  const currentSources = async selections => {
    // The shared builder reads current connection rows, validates each exact
    // incarnation and binds the resulting source in one owner operation.
    const sources = await calendarOwner.invoke('calendar:connections:build', { selections });
    if (!Array.isArray(sources) || sources.length !== selections.length) {
      throw new Error('The calendar source could not be checked.');
    }
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (source?.unavailable || !sameSelection(source, selections[index])) {
        throw invalidSelection('calendar-unavailable', 'The selected calendar is no longer available. Select a current calendar.');
      }
    }
    return sources;
  };

  const validateSelections = async link => {
    let selections;
    try { selections = selectionsFor(link); }
    catch (error) { throw invalidSelection('calendar-selection-invalid', String(error?.message ?? 'Choose a current calendar.')); }
    for (const cohost of Array.isArray(link?.cohosts) ? link.cohosts : []) {
      if (cohost?.email !== undefined && !validInviteEmail(cohost.email)) {
        throw invalidSelection('invalid-cohost-email', 'Use a valid email address for each co-host invitation.');
      }
    }
    const sources = await currentSources(selections);
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const declaration = settings.sources.find(row => row.id === source.base_source)?.calendar_connection;
      const role = source.access_role;
      if (!declaration || !declaration.readable_roles.includes(role)
        || (index === 0 && (!source.writable || !declaration.writable_roles.includes(role)))) {
        throw invalidSelection(index === 0 ? 'primary-calendar-not-writable' : 'cohost-calendar-not-readable',
          index === 0 ? 'The selected primary calendar is no longer writable. Choose a writable calendar.'
            : 'A co-host calendar is no longer readable. Reconnect it or choose another calendar.');
      }
    }
    return { selections, sources };
  };

  const readOne = async (selection, fromMs, toMs, { excludeEventId, excludeEventIds, excludeCopy, invitationEmail, expectedSource } = {}) => {
    const [source] = await currentSources([selection]);
    if (expectedSource && (source.access_role !== expectedSource.access_role || source.time_zone !== expectedSource.time_zone)) {
      return { status: 'unknown', busy: [], error: 'calendar-selection-changed-during-read' };
    }
    const from = iso(fromMs), to = iso(toMs);
    if (source.read_mode === 'busy') {
      const input = fill(source.busy_source?.input ?? source.input ?? {}, { '{from}': from, '{to}': to });
      const result = await workshop.run({ tool_id: source.tool, input,
        request_key: `availability-busy:${source.id}:${from}:${to}:${crypto.randomUUID()}`, wait_seconds: 30 });
      if (result?.state !== 'completed') return { status: 'unknown', busy: [], error: result?.error ?? 'calendar-busy-read-incomplete' };
      const declaration = settings.sources.find(row => row.id === source.base_source);
      const busySource = source.busy_source ?? declaration?.calendar_connection?.busy_source;
      const rows = atPath(result.output, busySource?.rows);
      if (!Array.isArray(rows)) return { status: 'unknown', busy: [], error: 'calendar-busy-read-incomplete' };
      const errors = atPath(result.output, busySource?.errors_path);
      if (errors !== undefined && (!Array.isArray(errors) || errors.length)) return { status: 'unknown', busy: [], error: 'calendar-busy-read-incomplete' };
      const maxRows = Number.isSafeInteger(busySource?.max_rows) && busySource.max_rows > 0 ? busySource.max_rows : 1000;
      if (rows.length > maxRows) return { status: 'unknown', busy: [], error: 'calendar-busy-read-incomplete' };
      const busy = [];
      for (const row of rows) {
        const start = firstPath(row, busySource?.fields?.starts_at) ?? firstPath(row, busySource?.fields?.start) ?? row?.start;
        const end = firstPath(row, busySource?.fields?.ends_at) ?? firstPath(row, busySource?.fields?.end) ?? row?.end;
        const value = interval({ starts_at: start, ends_at: end }, source.time_zone);
        if (!value) return { status: 'unknown', busy: [], error: 'calendar-busy-read-incomplete' };
        busy.push(value);
      }
      return { status: 'read', busy };
    }

    // Writable event sources carry identities, which lets a move exclude only
    // its own existing event while retaining every other overlapping event.
    const declaration = settings.sources.find(row => row.id === source.base_source) ?? {};
    const pagination = declaration.pagination;
    const maxPages = Number.isSafeInteger(pagination?.max_pages) && pagination.max_pages > 0 ? pagination.max_pages : 1;
    // The caller's bounded read budget applies even when a provider returns
    // more rows than its page-size request. Source DATA may narrow that budget.
    const maxRows = Number.isSafeInteger(pagination?.max_rows) && pagination.max_rows > 0 ? Math.min(pagination.max_rows, maxBusyRows) : maxBusyRows;
    const all = [], seen = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const input = fill(source.input ?? {}, { '{from}': from, '{to}': to });
      if (cursor) input[pagination.input_field] = cursor;
      const result = await workshop.run({ tool_id: source.tool, input,
        request_key: `availability-events:${source.id}:${from}:${to}:${page}:${crypto.randomUUID()}`, wait_seconds: 30 });
      if (result?.state !== 'completed') return { status: 'unknown', busy: [], error: result?.error ?? 'calendar-event-read-incomplete' };
      const rows = atPath(result.output, declaration.rows);
      if (!Array.isArray(rows)) return { status: 'unknown', busy: [], error: 'calendar-event-read-incomplete' };
      if (all.length + rows.length > maxRows) return { status: 'unknown', busy: [], error: 'calendar-event-read-row-limit' };
      all.push(...rows);
      const next = atPath(result.output, pagination?.next_cursor);
      if (!next) { cursor = undefined; break; }
      if (!nonempty(next) || seen.has(next) || page === maxPages - 1) return { status: 'unknown', busy: [], error: 'calendar-event-read-incomplete' };
      seen.add(next); cursor = next;
    }
    const idPath = declaration.fields?.id?.[0];
    if ((excludeEventId || excludeEventIds?.size) && !Array.isArray(idPath)) return { status: 'unknown', busy: [], error: 'calendar-event-identity-unavailable' };
    const fields = declaration.fields ?? {};
    const eventIdentity = row => {
      const organizerEmail = normalizedEmail(firstPath(row, fields.organizer_email));
      const start = normalizedTime(firstPath(row, fields.starts_at));
      const end = normalizedTime(firstPath(row, fields.ends_at));
      const originalStartValue = firstPath(row, fields.original_starts_at);
      const originalStart = originalStartValue === undefined ? null : normalizedTime(originalStartValue);
      const attendeeRows = firstPath(row, fields.attendees);
      const attendeePath = fields.attendee_email?.[0];
      const attendees = Array.isArray(attendeeRows) && Array.isArray(attendeePath)
        ? attendeeRows.map(attendee => normalizedEmail(atPath(attendee, attendeePath))).filter(Boolean) : [];
      const uid = firstPath(row, fields.ical_uid);
      if (!nonempty(uid) || !organizerEmail || !start || !end || end <= start
        || (originalStartValue !== undefined && !originalStart)) return null;
      return { uid, organizerEmail, start, end, originalStart, attendees };
    };
    const sameMeeting = (left, right) => left && right && left.uid === right.uid
      && left.organizerEmail === right.organizerEmail && left.start === right.start && left.end === right.end
      && left.originalStart === right.originalStart;
    const primaryCandidates = excludeEventId
      ? all.filter(row => atPath(row, idPath) === excludeEventId) : [];
    const excludedPrimary = primaryCandidates.length === 1 ? primaryCandidates[0] : null;
    const primaryIdentity = excludedPrimary ? eventIdentity(excludedPrimary) : null;
    const copyCandidates = excludeCopy && invitationEmail && normalizedEmail(invitationEmail)
      ? all.filter(row => {
        const identity = eventIdentity(row);
        const invite = normalizedEmail(invitationEmail);
        return excludeCopy.attendees.includes(invite) && sameMeeting(identity, excludeCopy) && identity.attendees.includes(invite);
      }) : [];
    const excludedCopy = copyCandidates.length === 1 ? copyCandidates[0] : null;
    const busy = [];
    for (const row of all) {
      // The source tool is already bound to this exact provider/account/calendar
      // incarnation. Compare the provider's event id only inside that response;
      // never apply an id from one calendar to another calendar's rows.
      if (row === excludedPrimary || row === excludedCopy) continue;
      // Events of the link's other seats at this time are not busy time for it.
      if (excludeEventIds?.size && excludeEventIds.has(atPath(row, idPath))) continue;
      if (row?.status === 'cancelled' || row?.transparency === 'transparent') continue;
      const starts = declaration.fields?.starts_at ?? [];
      const ends = declaration.fields?.ends_at ?? [];
      const start = firstPath(row, starts), end = firstPath(row, ends);
      const value = interval({ starts_at: start, ends_at: end }, source.time_zone);
      if (!value) return { status: 'unknown', busy: [], error: 'calendar-event-read-incomplete' };
      busy.push(value);
    }
    return { status: 'read', busy, ...(primaryIdentity ? { meeting_identity: primaryIdentity } : {}) };
  };

  const readBusy = async ({ link, from_ms, to_ms, exclude_event, exclude_events, by_calendar } = {}) => {
    if (!Number.isSafeInteger(from_ms) || !Number.isSafeInteger(to_ms) || to_ms <= from_ms) return { status: 'unknown', busy: [], error: 'invalid-calendar-range' };
    try {
      const { selections: selected, sources: before } = await validateSelections(link);
      const busy = [];
      const byCalendar = [];
      let movedMeeting;
      for (let index = 0; index < selected.length; index += 1) {
        const selection = selected[index];
        const isOriginalCalendar = exclude_event && selection.source_id === exclude_event.calendar?.source_id
          && selection.connection_id === exclude_event.calendar?.connection_id
          && selection.connected_at === exclude_event.calendar?.connected_at
          && selection.calendar_id === exclude_event.calendar?.calendar_id;
        const cohost = index > 0 ? link?.cohosts?.[index - 1] : null;
        const cohostEmail = cohost && sameCalendar(selection, calendarOf(cohost)) ? cohost.email : undefined;
        const seatEvents = new Set((exclude_events ?? []).filter(event => sameCalendar(selection, event.calendar)).map(event => event.event_id));
        const result = await readOne(selection, from_ms, to_ms, {
          expectedSource: before[index],
          ...(seatEvents.size ? { excludeEventIds: seatEvents } : {}),
          ...(isOriginalCalendar ? { excludeEventId: exclude_event.event_id } : {}),
          ...(index > 0 && movedMeeting ? { excludeCopy: movedMeeting, invitationEmail: cohostEmail } : {}),
        });
        if (result.status !== 'read') return { status: 'unknown', busy: [], error: result.error };
        if (isOriginalCalendar) movedMeeting = result.meeting_identity ?? null;
        busy.push(...result.busy);
        byCalendar.push({ calendar: { source_id: selection.source_id, connection_id: selection.connection_id, calendar_id: selection.calendar_id, connected_at: selection.connected_at }, busy: result.busy });
      }
      // A connection, calendar role or account incarnation can change while
      // Workshop is reading. Discard the complete answer if that happened.
      const { sources: after } = await validateSelections(link);
      if (after.some((source, index) => source.access_role !== before[index].access_role || source.time_zone !== before[index].time_zone)) {
        return { status: 'unknown', busy: [], error: 'calendar-selection-changed-during-read' };
      }
      return { status: 'read', busy, ...(by_calendar ? { by_calendar: byCalendar } : {}) };
    } catch (error) {
      return { status: error?.read_status ?? 'unknown', ...(error?.code ? { code: error.code } : {}), busy: [], error: String(error?.message ?? 'calendar-busy-read-incomplete') };
    }
  };

  const actionFor = kind => ({ reserve: 'create', move: 'move', cancel: 'cancel' })[kind] ?? null;
  const eventInput = (operation, link, reservation) => {
    // A link whose bookings carry a video call makes its event through the calendar's `create-video-call` action (src/calendar.json).
    const action = operation.kind === 'reserve' && link.video_call === true ? 'create-video-call' : actionFor(operation.kind);
    if (!action) throw new TypeError('Unsupported availability calendar operation.');
    const input = {};
    if (operation.kind === 'reserve') {
      Object.assign(input, { title: link.title, start: iso(reservation.start_ms), end: iso(reservation.end_ms), time_zone: link.timezone });
      if (nonempty(link.description)) input.description = link.description;
      if (nonempty(link.location)) input.location = link.location;
      const attendees = [];
      if (validInviteEmail(reservation.recipient?.email)) attendees.push({ email: reservation.recipient.email.trim() });
      for (const cohost of Array.isArray(link.cohosts) ? link.cohosts : []) {
        if (validInviteEmail(cohost?.email) && !attendees.some(attendee => attendee.email.toLowerCase() === cohost.email.trim().toLowerCase())) {
          attendees.push({ email: cohost.email.trim() });
        }
      }
      if (attendees.length) input.attendees = attendees;
    } else if (operation.kind === 'move') {
      if (!nonempty(reservation.external_event_id)) throw new TypeError('The original calendar event identity is unavailable.');
      input.event_id = reservation.external_event_id;
      Object.assign(input, { start: iso(operation.requested_start_ms), end: iso(operation.requested_end_ms) });
    } else if (operation.kind === 'cancel') {
      if (!nonempty(reservation.external_event_id)) throw new TypeError('The original calendar event identity is unavailable.');
      input.event_id = reservation.external_event_id;
    }
    return { action, input };
  };
  const runOperation = async ({ operation, link, reservation, request_key }) => {
    if (!operation || !link || !reservation || !operation.effect_input) return { state: 'unknown', error: 'original-effect-input-missing' };
    if (request_key !== operation.id) return { state: 'unknown', error: 'original-effect-request-key-mismatch' };
    if (canonical(operation.effect_input) !== canonical({ link, reservation })) return { state: 'unknown', error: 'original-effect-input-changed' };
    try {
      const { action, input } = eventInput(operation, link, reservation);
      let binding = await readEffectBinding(operation.id);
      if (binding) {
        try {
          const task = await workshop.snapshot({ task_id: binding.task_id });
          if (task.task_id !== binding.task_id || task.tool_id !== binding.tool_id || task.request_key !== binding.request_key)
            return { state: 'unknown', error: 'original-workshop-task-mismatch' };
          return effectTaskResult(task, { needsEvent: operation.kind !== 'cancel' });
        } catch (error) {
          if (error.code !== 'task-not-found' || error.task_id !== binding.task_id) throw error;
          // The binding exists but the original task has not been admitted.
          // Admit its unchanged tool/input/key through the same Workshop owner.
        }
      }
      if (!binding) {
        const [source] = await currentSources([link.calendar]);
        const declaration = settings.sources.find(row => row.id === source.base_source)?.calendar_connection;
        if (!declaration || !source.writable || !declaration.writable_roles.includes(source.access_role)) {
          return { state: 'refused', error: 'The selected primary calendar is no longer writable.' };
        }
        const prepared = prepareCalendarAction({ source: source.id, action, input, request_key: `availability:${operation.id}` }, { sources: [source] });
        binding = await keepEffectBinding(operation.id, { ...prepared, task_id: workshopTaskId(prepared) });
      }
      if (!binding?.tool_id || !binding?.task_id || !binding?.request_key || !object(binding.input)) return { state: 'unknown', error: 'original-workshop-binding-incomplete' };
      const result = await workshop.run({ tool_id: binding.tool_id, input: binding.input, request_key: binding.request_key, wait_seconds: 30 });
      return effectTaskResult(result, { needsEvent: operation.kind !== 'cancel' });
    } catch (error) {
      const message = String(error?.message ?? '');
      // A thrown failure after dispatch is uncertainty, even when its text
      // resembles a capability refusal. Workshop owns definitive no-send facts.
      return { state: 'unknown', error: message || 'calendar-effect-outcome-unknown' };
    }
  };

  const effects = Object.freeze({
    ensure: runOperation,
    async reconcile({ operation, link, reservation } = {}) {
      try {
        if (!operation || !link || !reservation || !operation.effect_input
          || canonical(operation.effect_input) !== canonical({ link, reservation })) return { state: 'unknown', error: 'original-effect-input-missing' };
        const identity = await readEffectBinding(operation.id);
        // The domain calls ensure first to recover original task admission.
        // Reconciliation itself only inspects that exact task.
        if (!identity) return { state: 'unknown', error: 'original-workshop-binding-not-yet-admitted' };
        let task;
        try { task = await workshop.snapshot({ task_id: identity.task_id }); }
        catch (error) {
          // A prepared binding may be durable before Workshop admits the task.
          // Only this owner's explicit absence result permits admission again;
          // transport/rights failures remain uncertain. The frozen tool/input
          // and key still produce the same task, never a replacement target.
          throw error;
        }
        if (task.task_id !== identity.task_id || task.tool_id !== identity.tool_id || task.request_key !== identity.request_key) {
          return { state: 'unknown', error: 'original-workshop-task-mismatch' };
        }
        return effectTaskResult(task, { needsEvent: operation.kind !== 'cancel' });
      } catch (error) {
        return { state: 'unknown', error: String(error?.message ?? 'original-workshop-task-unavailable') };
      }
    },
  });

  return Object.freeze({ async validateLink(link) {
    if ((link?.cohosts ?? []).some(host => !validInviteEmail(host?.email))) throw invalidSelection('invalid-cohost-email', 'Add a valid invitation email for each co-host.');
    const { sources } = await validateSelections(link);
    // Seats share one time, and each seat's own event must be told apart from other busy time, which a busy-only source cannot do.
    if ((link?.seats_per_slot ?? 1) > 1 && sources.some(source => source.read_mode === 'busy')) {
      throw invalidSelection('seats-need-event-calendar', 'A link with several seats needs a calendar that lists events, not only busy times.');
    }
    return true;
  }, readBusy, effects });
}

