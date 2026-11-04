// Personal availability links and their reservations, kept in the caller's
// current EEAF owner. This module owns no database, queue, clock or provider
// connection; the native resource supplies those current owners.
import { deriveOpenSlots, type AvailabilityWindow, type Interval, type OpenSlot } from './derive-open-slots.ts';
import { timeZoneName } from '../../timed-action/do-work/wall-time.ts';

export type AvailabilityLinkState = 'active' | 'revoked' | 'deleted';
export type ReservationState = 'requested' | 'pending' | 'booked' | 'cancelled' | 'failed';
export type AvailabilityOperationKind = 'request' | 'reserve' | 'move' | 'cancel';
export type EffectState = 'completed' | 'pending' | 'failed' | 'refused' | 'unknown';
export type AvailabilityCalendar = { source_id: string; connection_id: string; calendar_id: string; connected_at: string };

export interface AvailabilityLinkInput {
  title: string;
  calendar: AvailabilityCalendar;
  description?: string | null;
  location?: string | null;
  alias?: string | null;
  // Identity and calendar policy for co-hosts are resolved by the injected
  // account/connection owners; this domain keeps their declaration as data.
  cohosts?: unknown[];
  timezone: string;
  windows: AvailabilityWindow[];
  duration_min: number;
  step_min: number;
  buffer_before_min?: number;
  buffer_after_min?: number;
  min_notice_min?: number;
  horizon_days?: number;
  expires_at?: string | null;
  one_off_slots?: Array<{ start_ms: number; end_ms: number }>;
  preferred_times_snapshot?: unknown;
  /** At most this many held (pending or booked) reservations under one share grant of this link (one purchase's
   * link, say); null: no limit. Reservations the organizer makes are under no grant. */
  per_grant_max?: number | null;
  /** At most this many held reservations of this link start on one day in its time zone; null: no limit. */
  per_day_max?: number | null;
  /** A recipient may move or cancel only until this many minutes before the reservation starts. */
  change_notice_min?: number;
  /** The calendar event is made with a video call (the calendar's `create-video-call` action). */
  video_call?: boolean;
  /** How many people may hold the same time of this link; null or 1: one. Each seat is its own reservation (and its own
   * calendar event, so the first seat's event never makes the time look busy to the next). Not with co-hosts. */
  seats_per_slot?: number | null;
  /** How the link's hosts share its times: `everyone` (every host attends, so a time must be free for all of them) or
   * `take_turns` (a time is offered when any one host is free, and each booking goes to one host, spread by weight). */
  host_mode?: string;
  /** The weight of the link's own calendar when hosts take turns (a co-host's weight is on the co-host); default 1. */
  host_weight?: number;
  /** A booking starts as a request that the organizer confirms (the calendar event is made then) or declines. */
  requires_confirmation?: boolean;
  /** While a request waits it holds its time; false: others may still take that time, and confirming then fails if it is gone. */
  pending_blocks_slot?: boolean;
  // Amie's Repeat toggle reuses slots in future weeks.
  repeat: boolean;
}

export interface AvailabilityLink extends AvailabilityLinkInput {
  id: string;
  state: AvailabilityLinkState;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface AvailabilityReservation {
  id: string;
  link_id: string;
  recipient_identity: string;
  calendar: AvailabilityLinkInput['calendar'];
  state: ReservationState;
  start_ms: number;
  end_ms: number;
  occupied_start_ms?: number;
  occupied_end_ms?: number;
  created_at: string;
  updated_at: string;
  external_event_id?: string;
  recipient?: { name?: string; email?: string };
  /** The share grant the recipient was admitted through (an opaque reference, never the link's code). */
  grant_ref?: string;
  /** A request (state `requested`) that holds its time while it waits, copied from the link when it was made. */
  holds_slot?: boolean;
  /** Who ended a reservation that never reached the calendar (a request), and why. */
  ended_by?: string;
  ended_reason?: string;
  last_operation_id?: string;
  pending_operation_id?: string;
  pending_start_ms?: number;
  pending_end_ms?: number;
  pending_occupied_start_ms?: number;
  pending_occupied_end_ms?: number;
  /** Exact calendar incarnations holding the original interval (primary first). */
  host_calendars?: AvailabilityCalendar[];
  /** Exact calendar incarnations holding the requested interval during a move. */
  pending_host_calendars?: AvailabilityCalendar[];
}

export interface AvailabilityOperation {
  id: string;
  identity: string;
  request_key: string;
  kind: AvailabilityOperationKind;
  link_id: string;
  reservation_id: string;
  input_identity: string;
  state: 'pending' | 'completed' | 'failed' | 'refused';
  requested_start_ms?: number;
  requested_end_ms?: number;
  external_event_id?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  /** Original provider/task input; later link edits cannot change an admitted effect. */
  effect_input?: { link: AvailabilityLink; reservation: AvailabilityReservation };
}

export interface AvailabilityLinkStore {
  readLink(id: string): AvailabilityLink | null;
  writeLink(link: AvailabilityLink): void;
  listLinks(input: { after?: string; limit: number }): { links: AvailabilityLink[]; next_cursor: string | null };
  readReservation(id: string): AvailabilityReservation | null;
  writeReservation(reservation: AvailabilityReservation): void;
  // The reservation invariant is shared by all links for the same exact
  // calendar incarnation. Include old and requested occupied intervals.
  queryReservations(input: { calendar: AvailabilityLinkInput['calendar']; calendars?: AvailabilityCalendar[]; from_ms: number; to_ms: number; limit: number }): { reservations: AvailabilityReservation[]; complete: boolean };
  // One bounded page of a link's reservations in record-id order; `after` is the last record id of the page before.
  reservationsOfLink?(input: { link_id: string; after?: string | null; limit: number }): { rows: Array<{ record_id: string; reservation: AvailabilityReservation | null }>; next: string | null };
  // How many held (pending or booked) reservations one share grant holds on one link, counting at most `limit`.
  countGrantReservations(input: { link_id: string; grant_ref: string; limit: number }): number;
  readOperation(id: string): AvailabilityOperation | null;
  writeOperation(operation: AvailabilityOperation): void;
}

export interface AvailabilityEffectResult {
  state: EffectState;
  external_event_id?: string;
  error?: string;
}

export interface RecipientPrincipal { identity: string; organizer?: boolean; grant?: string }

export interface AvailabilityLinkOwnerDependencies {
  // Adapter methods must use the injected resource's current EEAF owner.
  store: AvailabilityLinkStore;
  transaction<T>(change: () => T): T;
  current(operation: string, input: unknown): Promise<void> | void;
  assertCurrentCommit(operation: string, input: unknown): void;
  // Recipient admission checks the current link grant/recipient policy on each call.
  // `organizer: true` marks the link's own account acting for a recipient: the recipient change cutoff does not bind it.
  // `grant` is the opaque reference of the share grant a recipient was admitted through (a link's per_grant_max).
  authorizeRecipient(input: { operation: string; link_id?: string; reservation_id?: string; operation_id?: string; link?: AvailabilityLink; reservation?: AvailabilityReservation | null; recipient: unknown }): Promise<RecipientPrincipal> | RecipientPrincipal;
  // Verify the same grant/principal inside the reservation storage transaction, with no await.
  assertRecipientCommit(input: { operation: string; link: AvailabilityLink; reservation?: AvailabilityReservation; recipient: unknown; identity: string }): void;
  // Canonical per-recipient identity, never a shared link code or caller-supplied name/email.
  // Must read connected-calendar busy intervals now, never from a stale slot cache.
  readBusy(input: { link: AvailabilityLink; from_ms: number; to_ms: number; reservation?: AvailabilityReservation;
    exclude_event?: { calendar: AvailabilityLinkInput['calendar']; event_id: string };
    // Events of this link's other seats at the same time: they are not busy time for a seated link.
    exclude_events?: Array<{ calendar: AvailabilityLinkInput['calendar']; event_id: string }>;
    // Also answer each host calendar's own busy time (`by_calendar`), for hosts who take turns.
    by_calendar?: boolean }): Promise<{ status: 'read' | 'unknown'; busy: Interval[]; by_calendar?: Array<{ calendar: AvailabilityCalendar; busy: Interval[] }>; error?: string }>;
  effects: {
    /** Admit/read the same durable task by operation.id; never invoke a raw provider mutation here.
     * The existing task/effect owner must deduplicate concurrent admission and recover dispatch after a crash. */
    ensure(input: { operation: AvailabilityOperation; link: AvailabilityLink; reservation: AvailabilityReservation; request_key: string }): Promise<AvailabilityEffectResult>;
    // Reconcile is a read of existing provider/task state. It must never redispatch a mutation.
    reconcile(input: { operation: AvailabilityOperation; link: AvailabilityLink; reservation: AvailabilityReservation }): Promise<AvailabilityEffectResult>;
  };
  now(): number;
  opaqueId(): string;
  identity(value: unknown): string;
  max_list?: number;
  max_horizon_days?: number;
  max_range_days?: number;
  max_held_reservations?: number;
  max_seats?: number;
  // Days around a time that count when hosts who take turns are spread evenly (default 7).
  fairness_window_days?: number;
}

export class AvailabilityLinkError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'availability-link-invalid') {
    super(message); this.status = status; this.code = code;
  }
}

const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};
const dayMs = 86_400_000;
// How hosts share a link's times. A mode is a row, not a branch: `needsEveryone` says whether one time must be free for
// all hosts or for any one of them.
const hostModes: Record<string, { everyone: boolean }> = { everyone: { everyone: true }, take_turns: { everyone: false } };
const sameCalendarIdentity = (left: any, right: any) => ['source_id', 'connection_id', 'calendar_id', 'connected_at']
  .every(key => left?.[key] === right?.[key]);
const checkTimeZone = (timezone: unknown) => {
  if (!nonempty(timezone)) throw new AvailabilityLinkError('Choose a time zone.');
  if (!timeZoneName(timezone)) throw new AvailabilityLinkError('Choose a time zone Trillion knows.');
};

function validateInput(input: AvailabilityLinkInput, deps: AvailabilityLinkOwnerDependencies, retainedSlots: AvailabilityLinkInput['one_off_slots'] = []): AvailabilityLinkInput {
  if (!object(input)) throw new AvailabilityLinkError('Send the availability link details.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 160) throw new AvailabilityLinkError('Give this availability link a title of at most 160 characters.');
  if (!object(input.calendar) || !['source_id', 'connection_id', 'calendar_id', 'connected_at'].every(key => nonempty(input.calendar[key]) && input.calendar[key].length <= 500)) throw new AvailabilityLinkError('Choose a current writable calendar.');
  for (const field of ['description', 'location', 'alias'] as const) {
    const value = input[field];
    if (value != null && (typeof value !== 'string' || value.length > (field === 'description' ? 4000 : 300))) throw new AvailabilityLinkError(`The ${field} is too long.`);
  }
  if (input.cohosts !== undefined && (!Array.isArray(input.cohosts) || input.cohosts.length > 20)) throw new AvailabilityLinkError('Choose at most 20 co-hosts.');
  if (input.cohosts?.some(host => !object(host) || !object(host.calendar)
    || !['source_id', 'connection_id', 'calendar_id', 'connected_at'].every(key => nonempty(host.calendar[key]) && host.calendar[key].length <= 500))) {
    throw new AvailabilityLinkError('Each co-host needs a current calendar identity.');
  }
  checkTimeZone(input.timezone);
  if (typeof input.repeat !== 'boolean') throw new AvailabilityLinkError('Choose whether these times repeat in future weeks.');
  if (!Array.isArray(input.windows) || input.windows.length > 84 || (input.repeat && !input.windows.length)) throw new AvailabilityLinkError('Choose at least one weekly availability time.');
  if (!input.repeat && (!Array.isArray(input.one_off_slots) || !input.one_off_slots.length || input.one_off_slots.length > 200)) throw new AvailabilityLinkError('Choose at least one one-off time.');
  if (input.one_off_slots !== undefined && (!Array.isArray(input.one_off_slots) || input.one_off_slots.length > 200
    || input.one_off_slots.some(slot => !Number.isFinite(slot?.start_ms) || !Number.isFinite(slot?.end_ms) || slot.end_ms <= slot.start_ms))) {
    throw new AvailabilityLinkError('Each one-off time needs a valid start and end.');
  }
  const oneOffs = [...(input.one_off_slots ?? [])].sort((a, b) => a.start_ms - b.start_ms);
  if (oneOffs.some((slot, index) => index > 0 && slot.start_ms < oneOffs[index - 1].end_ms)) throw new AvailabilityLinkError('One-off times cannot overlap.');
  for (const window of input.windows) {
    if (!object(window) || !Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6
      || typeof window.start !== 'string' || typeof window.end !== 'string') throw new AvailabilityLinkError('Each availability time needs a weekday, start and end.');
    const start = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start) ? Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3)) : NaN;
    const end = window.end === '24:00' ? 1440 : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end) ? Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3)) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new AvailabilityLinkError('Each weekly time must end after it starts on the same day.');
  }
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const windows = input.windows.filter(window => window.weekday === weekday)
      .map(window => [Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3)),
        window.end === '24:00' ? 1440 : Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3))] as const)
      .sort((a, b) => a[0] - b[0]);
    if (windows.some((window, index) => index > 0 && window[0] < windows[index - 1][1])) throw new AvailabilityLinkError('Weekly availability times cannot overlap.');
  }
  for (const [field, value] of [['duration_min', input.duration_min], ['step_min', input.step_min]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1440) throw new AvailabilityLinkError(`${field} must be a positive whole number of minutes.`);
  }
  for (const [field, value] of [['buffer_before_min', input.buffer_before_min ?? 0], ['buffer_after_min', input.buffer_after_min ?? 0], ['min_notice_min', input.min_notice_min ?? 0]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 525600) throw new AvailabilityLinkError(`${field} must be a non-negative whole number of minutes.`);
  }
  for (const [field, value] of [['per_grant_max', input.per_grant_max ?? null], ['per_day_max', input.per_day_max ?? null]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 1000)) throw new AvailabilityLinkError(`${field} must be a whole number from 1 to 1000, or null.`);
  }
  const changeNotice = input.change_notice_min ?? 0;
  if (!Number.isSafeInteger(changeNotice) || changeNotice < 0 || changeNotice > 525600) throw new AvailabilityLinkError('change_notice_min must be a non-negative whole number of minutes.');
  if (input.video_call !== undefined && typeof input.video_call !== 'boolean') throw new AvailabilityLinkError('Choose whether each booking carries a video call.');
  const seats = input.seats_per_slot ?? null;
  if (seats !== null && (!Number.isSafeInteger(seats) || seats < 1 || seats > (deps.max_seats ?? 1000))) throw new AvailabilityLinkError('seats_per_slot must be a whole number of seats, or null.');
  if (seats !== null && seats > 1 && (input.cohosts?.length ?? 0) > 0) throw new AvailabilityLinkError('A link with several seats per time cannot have co-hosts.');
  if (input.host_mode !== undefined && (typeof input.host_mode !== 'string' || !Object.hasOwn(hostModes, input.host_mode))) throw new AvailabilityLinkError(`host_mode is one of: ${Object.keys(hostModes).join(', ')}.`);
  const weights = [input.host_weight, ...(input.cohosts ?? []).map(host => (host as any)?.weight)];
  if (weights.some(weight => weight !== undefined && (!Number.isSafeInteger(weight) || weight < 1 || weight > 100))) throw new AvailabilityLinkError('A host weight is a whole number from 1 to 100.');
  for (const field of ['requires_confirmation', 'pending_blocks_slot'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new AvailabilityLinkError(`${field} must be true or false.`);
  }
  const horizon = input.horizon_days ?? 60;
  if (!Number.isSafeInteger(horizon) || horizon < 1 || horizon > (deps.max_horizon_days ?? 366)) throw new AvailabilityLinkError('Choose an availability horizon within the allowed range.');
  const expires = input.expires_at ?? null;
  if (expires !== null && (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= deps.now())) throw new AvailabilityLinkError('The link expiry must be a future time or null.');
  if (input.one_off_slots?.some(slot => {
    const retained = retainedSlots?.some(previous => previous.start_ms === slot.start_ms && previous.end_ms === slot.end_ms);
    return (!(retained && slot.start_ms < deps.now()) && slot.end_ms - slot.start_ms !== input.duration_min * 60_000) || !retained && (
      slot.start_ms < deps.now() + (input.min_notice_min ?? 0) * 60_000 || slot.start_ms > deps.now() + horizon * dayMs);
  })) throw new AvailabilityLinkError('Each new one-off time must fit the duration and current availability horizon.');
  return { ...input, title, calendar: structuredClone(input.calendar), windows: structuredClone(input.windows), duration_min: input.duration_min, step_min: input.step_min,
    buffer_before_min: input.buffer_before_min ?? 0, buffer_after_min: input.buffer_after_min ?? 0,
    min_notice_min: input.min_notice_min ?? 0, horizon_days: horizon, expires_at: expires,
    per_grant_max: input.per_grant_max ?? null, per_day_max: input.per_day_max ?? null,
    change_notice_min: changeNotice, video_call: input.video_call ?? false,
    seats_per_slot: seats, host_mode: input.host_mode ?? 'everyone', host_weight: input.host_weight ?? 1, requires_confirmation: input.requires_confirmation ?? false, pending_blocks_slot: input.pending_blocks_slot ?? false,
    ...(Object.hasOwn(input, 'cohosts') ? { cohosts: structuredClone(input.cohosts) } : {}),
    ...(Object.hasOwn(input, 'one_off_slots') ? { one_off_slots: structuredClone(input.one_off_slots) } : {}),
    ...(Object.hasOwn(input, 'preferred_times_snapshot') ? { preferred_times_snapshot: structuredClone(input.preferred_times_snapshot) } : {}),
    repeat: input.repeat };
}

// A recipient change (move or cancel) is open until the link's change_notice_min before the reservation starts.
const changeOpen = (link: AvailabilityLink, reservation: AvailabilityReservation, principal: { organizer?: boolean } | null | undefined, now: number) =>
  principal?.organizer === true || reservation.start_ms - now >= (link.change_notice_min ?? 0) * 60_000;
const isLinkOpen = (link: AvailabilityLink, now: number) => link.state === 'active'
  && (!link.expires_at || Date.parse(link.expires_at) > now);
// Booked and pending reservations hold their time; a request holds it only when the link says so.
const occupying = (reservation: AvailabilityReservation) => reservation.state === 'booked' || reservation.state === 'pending'
  || (reservation.state === 'requested' && reservation.holds_slot === true);
const hostCalendars = (link: Pick<AvailabilityLinkInput, 'calendar' | 'cohosts'>): AvailabilityCalendar[] => {
  const calendars = [link.calendar, ...(link.cohosts ?? []).map(host => (host as any)?.calendar)];
  if (calendars.some(calendar => !object(calendar) || !['source_id', 'connection_id', 'calendar_id', 'connected_at'].every(key => nonempty(calendar[key])))) {
    throw new AvailabilityLinkError('Each co-host needs a current calendar identity.');
  }
  const exact: AvailabilityCalendar[] = calendars.map(calendar => ({ source_id: calendar.source_id, connection_id: calendar.connection_id,
    calendar_id: calendar.calendar_id, connected_at: calendar.connected_at }));
  return exact.filter((calendar, index) => exact.findIndex(candidate => sameCalendarIdentity(candidate, calendar)) === index);
};
// The link's hosts in calendar order (the link's own calendar first), each with the weight that spreads bookings.
const hostsOf = (link: Pick<AvailabilityLinkInput, 'calendar' | 'cohosts' | 'host_weight'>): Array<{ calendar: AvailabilityCalendar; weight: number }> => {
  const weights = new Map<string, number>();
  const key = (calendar: AvailabilityCalendar) => `${calendar.source_id}\u0000${calendar.connection_id}\u0000${calendar.calendar_id}\u0000${calendar.connected_at}`;
  const exact = hostCalendars(link);
  weights.set(key(exact[0]), link.host_weight ?? 1);
  for (const host of link.cohosts ?? []) if (!weights.has(key((host as any).calendar))) weights.set(key((host as any).calendar), (host as any).weight ?? 1);
  return exact.map(calendar => ({ calendar, weight: weights.get(key(calendar)) ?? 1 }));
};
const takesTurns = (link: AvailabilityLink) => !hostModes[link.host_mode ?? 'everyone']?.everyone && hostsOf(link).length > 1;
const linkForReservation = (link: AvailabilityLink, reservation: AvailabilityReservation): AvailabilityLink => {
  const calendars = reservation.host_calendars?.length ? reservation.host_calendars : [reservation.calendar];
  return { ...link, calendar: structuredClone(reservation.calendar), cohosts: calendars.slice(1).map(calendar => ({ calendar: structuredClone(calendar) })) };
};

export function createAvailabilityLinkOwner(deps: AvailabilityLinkOwnerDependencies) {
  if (!deps?.store || typeof deps.transaction !== 'function' || typeof deps.current !== 'function'
    || typeof deps.assertCurrentCommit !== 'function' || typeof deps.store.queryReservations !== 'function' || typeof deps.store.countGrantReservations !== 'function'
    || typeof deps.readBusy !== 'function' || typeof deps.authorizeRecipient !== 'function' || typeof deps.assertRecipientCommit !== 'function' || typeof deps.effects?.ensure !== 'function'
    || typeof deps.effects?.reconcile !== 'function' || typeof deps.identity !== 'function' || typeof deps.opaqueId !== 'function' || typeof deps.now !== 'function') {
    throw new TypeError('Availability links need the current EEAF store, transaction and identity owners.');
  }
  const maxList = deps.max_list ?? 50;
  // The one principal the organizer's own confirm and decline are recorded under.
  const organizerIdentity = 'organizer';
  const maxHeld = deps.max_held_reservations ?? 250;
  if (!Number.isSafeInteger(maxHeld) || maxHeld < 1 || maxHeld > 1000) throw new TypeError('Use a bounded reservation read limit.');
  const callCurrent = (operation: string, input: unknown) => deps.current(`availability:${operation}`, input);
  const write = (fn: () => any) => {
    const result = deps.transaction(fn);
    if (result && typeof result.then === 'function') throw new TypeError('Availability commitments require a synchronous transaction.');
    return result;
  };
  const operationRecordId = (kind: AvailabilityOperationKind, linkId: string, requestKey: string, recipientIdentity: string) =>
    `availability-operation:${deps.identity({ kind, link_id: linkId, request_key: requestKey.trim(), recipient_identity: recipientIdentity })}`;
  const assertRequestKey = (key: unknown) => {
    if (!nonempty(key) || key.trim().length > 200) throw new AvailabilityLinkError('Use a stable request_key of at most 200 characters.');
    return key.trim();
  };
  const assertLink = (id: unknown) => {
    if (!nonempty(id)) throw new AvailabilityLinkError('Name the availability link.', 404, 'not-found');
    const link = deps.store.readLink(id);
    if (!link) throw new AvailabilityLinkError('That availability link is unavailable.', 404, 'not-found');
    return link;
  };
  const assertReservation = (id: unknown) => {
    if (!nonempty(id)) throw new AvailabilityLinkError('Name the reservation.', 404, 'not-found');
    const reservation = deps.store.readReservation(id);
    if (!reservation) throw new AvailabilityLinkError('That reservation is unavailable.', 404, 'not-found');
    return reservation;
  };
  const dateRange = (link: AvailabilityLink, input: { from?: string; to?: string }) => {
    const today = day(deps.now(), link.timezone);
    const from = input.from ?? today;
    const defaultDays = Math.min(link.horizon_days ?? 60, deps.max_range_days ?? 90);
    const to = input.to ?? new Date(Date.parse(`${today}T00:00:00.000Z`) + defaultDays * dayMs).toISOString().slice(0, 10);
    const fromMs = Date.parse(`${from}T00:00:00.000Z`), toMs = Date.parse(`${to}T00:00:00.000Z`);
    const days = Math.round((toMs - fromMs) / dayMs);
    const latestDate = new Date(Date.parse(`${today}T00:00:00.000Z`) + (link.horizon_days ?? 60) * dayMs).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
      || new Date(fromMs).toISOString().slice(0, 10) !== from || new Date(toMs).toISOString().slice(0, 10) !== to
      || days < 0 || days > (deps.max_range_days ?? 90) || from < today || to > latestDate) throw new AvailabilityLinkError('Choose dates inside this link’s current availability horizon.');
    return { from, to, fromMs, toMs, days };
  };
  const rawSlots = (link: AvailabilityLink, from: string, days: number): OpenSlot[] => {
    if (!link.repeat) {
      const through = new Date(Date.parse(`${from}T00:00:00.000Z`) + days * dayMs).toISOString().slice(0, 10);
      return (link.one_off_slots ?? []).filter(slot => {
        const date = day(slot.start_ms, link.timezone);
        return date >= from && date <= through && slot.start_ms >= deps.now() + (link.min_notice_min ?? 0) * 60_000;
      }).map(slot => ({ startMs: slot.start_ms, endMs: slot.end_ms, date: day(slot.start_ms, link.timezone),
        time: new Intl.DateTimeFormat('en-US', { timeZone: link.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(slot.start_ms)) })).sort((a,b)=>a.startMs-b.startMs);
    }
    const result: OpenSlot[] = [];
    for (let offset = 0; offset <= days; offset += 1) {
      const dateISO = new Date(Date.parse(`${from}T00:00:00.000Z`) + offset * dayMs).toISOString().slice(0, 10);
      result.push(...deriveOpenSlots({ timezone: link.timezone, windows: link.windows, dateISO,
        durationMin: link.duration_min, stepMin: link.step_min, minNoticeMin: link.min_notice_min, nowMs: deps.now(), busy: [] }));
    }
    return result;
  };
  // `busy` may carry each host's own busy time (`byHost`, in host order) for hosts who take turns.
  type Busy = Interval[] & { byHost?: Interval[][] };
  type Offered = OpenSlot & { seats_left?: number; free_hosts?: number[] };
  const slotsFor = (link: AvailabilityLink, from: string, days: number, busy: Busy, except?: string): Offered[] => {
    const candidates = rawSlots(link, from, days);
    if (!candidates.length) return [];
    let fromMs = Infinity, toMs = -Infinity;
    for (const slot of candidates) { fromMs = Math.min(fromMs, slot.startMs); toMs = Math.max(toMs, slot.endMs); }
    const calendars = hostCalendars(link);
    // A day limit counts every held reservation of this link on the slots' whole days, so the read widens by a day each way.
    const dayWide = link.per_day_max ? dayMs : 0;
    const page = deps.store.queryReservations({ calendar: link.calendar, calendars,
      from_ms: fromMs - (link.buffer_before_min ?? 0) * 60_000 - dayWide, to_ms: toMs + (link.buffer_after_min ?? 0) * 60_000 + dayWide, limit: maxHeld });
    if (!page?.complete || !Array.isArray(page.reservations) || page.reservations.length > maxHeld) throw new AvailabilityLinkError('This date range has more reservations than one read can verify. Choose a shorter range.', 503, 'reservation-read-incomplete');
    const held = page.reservations.filter(row => row.id !== except && occupying(row));
    // Every interval a held reservation occupies, with the exact time it was reserved for: the seats of one link share
    // that exact time, and nothing else may overlap it.
    const blocks = held.flatMap(row => [
      { startMs: row.occupied_start_ms ?? row.start_ms, endMs: row.occupied_end_ms ?? row.end_ms, row, at: { start: row.start_ms, end: row.end_ms } },
      ...(row.pending_start_ms == null || row.pending_end_ms == null ? [] : [{ startMs: row.pending_occupied_start_ms ?? row.pending_start_ms, endMs: row.pending_occupied_end_ms ?? row.pending_end_ms, row, at: { start: row.pending_start_ms, end: row.pending_end_ms } }]),
    ]);
    const seats = link.seats_per_slot ?? 1;
    const sharesSeat = (block: { row: AvailabilityReservation; at: { start: number; end: number } }, slot: OpenSlot) =>
      seats > 1 && block.row.link_id === link.id && block.at.start === slot.startMs && block.at.end === slot.endMs;
    const perDay = new Map<string, number>();
    if (link.per_day_max) for (const row of held) if (row.link_id === link.id) {
      for (const date of new Set([day(row.start_ms, link.timezone), ...(row.pending_start_ms == null ? [] : [day(row.pending_start_ms, link.timezone)])])) perDay.set(date, (perDay.get(date) ?? 0) + 1);
    }
    const open: Offered[] = [];
    const hosts = hostsOf(link);
    const turns = takesTurns(link);
    const clashes = (slot: OpenSlot, intervals: Interval[]) => intervals.some(block => slot.startMs - (link.buffer_before_min ?? 0) * 60_000 < block.endMs && slot.endMs + (link.buffer_after_min ?? 0) * 60_000 > block.startMs);
    // The hosts a reservation occupies: its own calendars (one host when hosts take turns, all of them otherwise).
    const holds = (row: AvailabilityReservation, host: AvailabilityCalendar) => (row.host_calendars?.length ? row.host_calendars : [row.calendar]).some(held => sameCalendarIdentity(held, host));
    for (const slot of candidates) {
      if (link.per_day_max && (perDay.get(day(slot.startMs, link.timezone)) ?? 0) >= link.per_day_max) continue;
      const others = blocks.filter(block => !sharesSeat(block, slot));
      if (turns) {
        const free = hosts.map((host, index) => index).filter(index => !clashes(slot, [...(busy.byHost?.[index] ?? busy), ...others.filter(block => holds(block.row, hosts[index].calendar))])
          && !others.some(block => block.at.start === slot.startMs && holds(block.row, hosts[index].calendar)));
        if (free.length) open.push({ ...slot, free_hosts: free });
        continue;
      }
      if (others.some(block => block.at.start === slot.startMs)) continue;
      if (clashes(slot, [...busy, ...others])) continue;
      if (seats > 1) {
        const used = new Set(blocks.filter(block => sharesSeat(block, slot)).map(block => block.row.id)).size;
        if (used >= seats) continue;
        open.push({ ...slot, seats_left: seats - used });
      } else open.push(slot);
    }
    return open;
  };
  // The calendar events of this link's own seats in a range: a seated link's time is not busy because its other seats
  // already have an event there.
  const seatEvents = (link: AvailabilityLink, fromMs: number, toMs: number) => {
    if ((link.seats_per_slot ?? 1) <= 1) return [];
    const page = deps.store.queryReservations({ calendar: link.calendar, calendars: hostCalendars(link), from_ms: fromMs, to_ms: toMs, limit: maxHeld });
    if (!page?.complete) throw new AvailabilityLinkError('This date range has more reservations than one read can verify. Choose a shorter range.', 503, 'reservation-read-incomplete');
    return page.reservations.filter(row => row.link_id === link.id && nonempty(row.external_event_id))
      .map(row => ({ calendar: structuredClone(row.calendar), event_id: row.external_event_id! }));
  };
  // Among the hosts free for a time, the one whose bookings so far, around that time, are fewest for their weight; a tie
  // goes to the earlier host. A read that cannot be completed spreads nothing and takes the first free host.
  const pickHost = (link: AvailabilityLink, slot: Offered) => {
    const hosts = hostsOf(link);
    const free = slot.free_hosts?.length ? slot.free_hosts : [0];
    if (free.length === 1) return hosts[free[0]];
    const around = (deps.fairness_window_days ?? 7) * dayMs;
    const page = deps.store.queryReservations({ calendar: link.calendar, calendars: hostCalendars(link), from_ms: slot.startMs - around, to_ms: slot.endMs + around, limit: maxHeld });
    const held = page?.complete ? page.reservations.filter(row => row.link_id === link.id && occupying(row)) : [];
    const load = (index: number) => (held.filter(row => sameCalendarIdentity(row.calendar, hosts[index].calendar)).length + 1) / hosts[index].weight;
    return hosts[free.reduce((best, index) => load(index) < load(best) ? index : best)];
  };
  // Whether this recipient already holds a seat at exactly this time of this link.
  const heldBy = (link: AvailabilityLink, slot: OpenSlot, identity: string) => {
    const page = deps.store.queryReservations({ calendar: link.calendar, calendars: hostCalendars(link), from_ms: slot.startMs, to_ms: slot.endMs, limit: maxHeld });
    return page.reservations.some(row => row.link_id === link.id && occupying(row) && row.recipient_identity === identity
      && (row.start_ms === slot.startMs || row.pending_start_ms === slot.startMs));
  };
  const readBusy = async (link: AvailabilityLink, fromMs: number, toMs: number, reservation?: AvailabilityReservation) => {
    const seatEventsHere = seatEvents(link, fromMs, toMs);
    const turns = takesTurns(link);
    const result = await deps.readBusy({ link, from_ms: fromMs, to_ms: toMs,
      ...(seatEventsHere.length ? { exclude_events: seatEventsHere } : {}),
      ...(turns ? { by_calendar: true } : {}),
      ...(reservation ? { reservation, ...(reservation.external_event_id ? { exclude_event: { calendar: reservation.calendar, event_id: reservation.external_event_id } } : {}) } : {}) });
    if (result?.status !== 'read' || !Array.isArray(result.busy) || result.busy.some(interval => !Number.isFinite(interval?.startMs)
      || !Number.isFinite(interval?.endMs) || interval.endMs <= interval.startMs)) {
      throw new AvailabilityLinkError('Connected calendar availability could not be read. Try again shortly.', 503, 'calendar-busy-unknown');
    }
    const busy: Busy = [...result.busy];
    if (turns) {
      // Each host's own busy time, in host order; a host whose calendar was not answered cannot be offered.
      const answered = hostsOf(link).map(host => result.by_calendar?.find(entry => sameCalendarIdentity(entry.calendar, host.calendar)));
      if (answered.some(entry => !entry || !Array.isArray(entry.busy))) throw new AvailabilityLinkError('Connected calendar availability could not be read. Try again shortly.', 503, 'calendar-busy-unknown');
      busy.byHost = answered.map(entry => entry!.busy);
    }
    return busy;
  };
  const changeLink = (link: AvailabilityLink, change: Partial<AvailabilityLinkInput>, expectedRevision: unknown) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== link.revision) throw new AvailabilityLinkError('This availability link changed. Read it again before editing.', 409, 'revision-conflict');
    const next = validateInput({ ...link, ...change }, deps, link.one_off_slots);
    return write(() => {
      deps.assertCurrentCommit('availability:link:edit', { link_id: link.id, expected_revision: expectedRevision });
      const current = assertLink(link.id);
      if (current.revision !== expectedRevision) throw new AvailabilityLinkError('This availability link changed. Read it again before editing.', 409, 'revision-conflict');
      const saved: AvailabilityLink = { ...current, ...next, id: current.id, state: current.state, created_at: current.created_at,
        updated_at: iso(deps.now()), revision: current.revision + 1 };
      deps.store.writeLink(saved);
      return saved;
    });
  };
  const operationFor = (kind: AvailabilityOperationKind, linkId: string, requestKey: string, input: unknown, recipientIdentity: string) => {
    if (!nonempty(recipientIdentity)) throw new AvailabilityLinkError('The reservation recipient could not be verified.', 403, 'recipient-unverified');
    const id = operationRecordId(kind, linkId, requestKey, recipientIdentity);
    const inputIdentity = deps.identity(input);
    const existing = deps.store.readOperation(id);
    if (existing) {
      if (existing.identity !== id || existing.input_identity !== inputIdentity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
      return { operation: existing, repeated: true };
    }
    const operation: AvailabilityOperation = { id, identity: id, request_key: requestKey, kind, link_id: linkId,
      reservation_id: '', input_identity: inputIdentity, state: 'pending', created_at: iso(deps.now()), updated_at: iso(deps.now()) };
    return { operation, repeated: false };
  };
  const effectResult = (result: AvailabilityEffectResult): AvailabilityEffectResult => {
    if (!result || !['completed', 'pending', 'failed', 'refused', 'unknown'].includes(result.state)) return { state: 'unknown', error: 'provider-outcome-unknown' };
    return result;
  };
  const persistEffectOutcome = (operation: AvailabilityOperation, reservation: AvailabilityReservation, result: AvailabilityEffectResult) => write(() => {
    const currentOperation = deps.store.readOperation(operation.id);
    const currentReservation = assertReservation(reservation.id);
    if (!currentOperation || currentOperation.identity !== operation.identity) throw new AvailabilityLinkError('The original availability operation is unavailable.', 409, 'operation-changed');
    if (currentOperation.state !== 'pending') return { operation: currentOperation, reservation: currentReservation };
    if (currentOperation.input_identity !== operation.input_identity || currentReservation.pending_operation_id !== operation.id) throw new AvailabilityLinkError('The original reservation change is no longer current.', 409, 'operation-changed');
    if (result.state === 'completed' && operation.kind !== 'cancel' && !nonempty(result.external_event_id)) result = { state: 'unknown', error: 'The calendar has not confirmed an event identity.' };
    const now = iso(deps.now());
    let nextReservation = currentReservation;
    let nextOperation: AvailabilityOperation = { ...currentOperation, updated_at: now };
    if (result.state === 'completed') {
      nextOperation = { ...nextOperation, state: 'completed', ...(result.external_event_id ? { external_event_id: result.external_event_id } : {}) };
      if (operation.kind === 'reserve') nextReservation = { ...currentReservation, state: 'booked', ...(result.external_event_id ? { external_event_id: result.external_event_id } : {}), pending_operation_id: undefined, updated_at: now };
      else if (operation.kind === 'move') nextReservation = { ...currentReservation, start_ms: operation.requested_start_ms!, end_ms: operation.requested_end_ms!, occupied_start_ms: currentReservation.pending_occupied_start_ms, occupied_end_ms: currentReservation.pending_occupied_end_ms,
        ...(currentReservation.pending_host_calendars ? { host_calendars: currentReservation.pending_host_calendars } : {}),
        ...(result.external_event_id ? { external_event_id: result.external_event_id } : {}), pending_operation_id: undefined, pending_start_ms: undefined, pending_end_ms: undefined, pending_occupied_start_ms: undefined, pending_occupied_end_ms: undefined, pending_host_calendars: undefined, updated_at: now };
      else nextReservation = { ...currentReservation, state: 'cancelled', pending_operation_id: undefined, updated_at: now };
    } else if (result.state === 'failed' || result.state === 'refused') {
      nextOperation = { ...nextOperation, state: result.state, error: result.error };
      if (operation.kind === 'reserve') nextReservation = { ...currentReservation, state: 'failed', pending_operation_id: undefined, updated_at: now };
      else nextReservation = { ...currentReservation, pending_operation_id: undefined, pending_start_ms: undefined, pending_end_ms: undefined, pending_occupied_start_ms: undefined, pending_occupied_end_ms: undefined, pending_host_calendars: undefined, updated_at: now };
    }
    // pending and unknown remain pending, retaining the operation identity and blocking both old and requested slots.
    deps.store.writeOperation(nextOperation);
    deps.store.writeReservation(nextReservation);
    return { operation: nextOperation, reservation: nextReservation };
  });
  const reconcileExisting = async (operation: AvailabilityOperation, link: AvailabilityLink, reservation: AvailabilityReservation) => {
    if (operation.state !== 'pending') return { operation, reservation };
    if (!operation.effect_input) throw new AvailabilityLinkError('The original reservation change could not be read.', 409, 'effect-input-missing');
    const original = operation.effect_input;
    let result: AvailabilityEffectResult;
    try {
      result = effectResult(await deps.effects.ensure({ operation, link: original.link, reservation: original.reservation, request_key: operation.id }));
      if (result.state === 'pending' || result.state === 'unknown') result = effectResult(await deps.effects.reconcile({ operation, link: original.link, reservation: original.reservation }));
    } catch (error) { result = { state: 'unknown', error: String((error as Error)?.message ?? 'provider-outcome-unknown') }; }
    return persistEffectOutcome(operation, reservation, result);
  };
  const dispatchFirstEffect = async (operation: AvailabilityOperation, link: AvailabilityLink, reservation: AvailabilityReservation) => {
    // Both initial admission and recovery ask the same durable task owner with
    // the same exact input/key. A crash before task admission must remain recoverable.
    let result: AvailabilityEffectResult;
    try {
      if (!operation.effect_input) throw new AvailabilityLinkError('The original reservation change could not be read.', 409, 'effect-input-missing');
      result = await deps.effects.ensure({ operation, ...operation.effect_input, request_key: operation.id });
    } catch (error) {
      result = { state: 'unknown', error: String((error as Error)?.message ?? 'provider-outcome-unknown') };
    }
    return persistEffectOutcome(operation, reservation, effectResult(result));
  };
  // A request that never reached the calendar ends here, with no calendar change: the recipient withdrew it or the
  // organizer declined it. One transaction re-reads the request and records the finished operation.
  const endRequest = (reservationId: string, operation: AvailabilityOperation, endedBy: string, reason: string, verify?: (reservation: AvailabilityReservation) => void) => write(() => {
    const held = deps.store.readOperation(operation.id);
    if (held) {
      if (held.identity !== operation.identity || held.input_identity !== operation.input_identity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
      return { operation: held, reservation: assertReservation(held.reservation_id) };
    }
    const latest = assertReservation(reservationId);
    if (latest.state !== 'requested') throw new AvailabilityLinkError('Only a request that is still waiting can end this way. Read it again.', 409, 'reservation-changed');
    verify?.(latest);
    const now = iso(deps.now());
    const done: AvailabilityOperation = { ...operation, reservation_id: latest.id, state: 'completed', updated_at: now };
    const ended: AvailabilityReservation = { ...latest, state: 'cancelled', holds_slot: undefined, ended_by: endedBy, ended_reason: reason, last_operation_id: done.id, updated_at: now };
    deps.store.writeOperation(done); deps.store.writeReservation(ended);
    return { operation: done, reservation: ended };
  });
  const recipientReply = async (result: { operation: AvailabilityOperation | null; reservation: AvailabilityReservation }, recipient: unknown, operation: string) => {
    const link = assertLink(result.reservation.link_id);
    const principal = await deps.authorizeRecipient({ operation, link, reservation: result.reservation, recipient });
    if (principal?.identity !== result.reservation.recipient_identity) throw new AvailabilityLinkError('That reservation is unavailable.', 403, 'recipient-refused');
    deps.assertRecipientCommit({ operation, link: assertLink(link.id), reservation: result.reservation, recipient, identity: principal.identity });
    const reservation = assertReservation(result.reservation.id), held = result.operation;
    const changeable = changeOpen(link, reservation, principal, deps.now());
    return { timezone: link.timezone, may_move: changeable && isLinkOpen(assertLink(link.id), deps.now()) && reservation.state === 'booked' && !reservation.pending_operation_id,
      may_cancel: (changeable && reservation.state === 'booked' && !reservation.pending_operation_id) || reservation.state === 'requested',
      reservation: { id: reservation.id, link_id: reservation.link_id, state: reservation.state,
      start_ms: reservation.start_ms, end_ms: reservation.end_ms, created_at: reservation.created_at, updated_at: reservation.updated_at,
      ...(reservation.pending_start_ms == null ? {} : { pending_start_ms: reservation.pending_start_ms, pending_end_ms: reservation.pending_end_ms }) },
      operation: held ? { id: held.id, kind: held.kind, state: held.state, created_at: held.created_at, updated_at: held.updated_at,
        ...(['failed', 'refused'].includes(held.state) ? { error_code: 'calendar-change-failed' } : {}) } : null };
  };

  return Object.freeze({
    async create(input: AvailabilityLinkInput) {
      await callCurrent('link:create', input);
      const clean = validateInput(input, deps), now = iso(deps.now());
      const link: AvailabilityLink = { ...clean, id: deps.opaqueId(), state: 'active', created_at: now, updated_at: now, revision: 1 };
      write(() => { deps.assertCurrentCommit('availability:link:create', clean); deps.store.writeLink(link); });
      return link;
    },
    async read({ link_id }: { link_id: string }) {
      await callCurrent('link:read', { link_id });
      return assertLink(link_id);
    },
    async list({ after, limit = 25 }: { after?: string; limit?: number } = {}) {
      await callCurrent('link:list', { after, limit });
      const take = Math.max(1, Math.min(maxList, Number.isSafeInteger(limit) ? limit : 25));
      return deps.store.listLinks({ ...(after ? { after } : {}), limit: take });
    },
    async edit({ link_id, expected_revision, changes }: { link_id: string; expected_revision: number; changes: Partial<AvailabilityLinkInput> }) {
      await callCurrent('link:edit', { link_id, expected_revision, changes });
      const link = assertLink(link_id);
      if (link.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot be edited.', 409, 'link-deleted');
      return changeLink(link, changes, expected_revision);
    },
    async revoke({ link_id, expected_revision }: { link_id: string; expected_revision: number }) {
      await callCurrent('link:revoke', { link_id, expected_revision });
      return write(() => {
        deps.assertCurrentCommit('availability:link:revoke', { link_id, expected_revision });
        const link = assertLink(link_id);
        if (link.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot be restored.', 409, 'link-deleted');
        if (link.revision !== expected_revision) throw new AvailabilityLinkError('This availability link changed. Read it again before revoking.', 409, 'revision-conflict');
        const saved = { ...link, state: 'revoked' as const, revision: link.revision + 1, updated_at: iso(deps.now()) };
        deps.store.writeLink(saved); return saved;
      });
    },
    async delete({ link_id, expected_revision }: { link_id: string; expected_revision: number }) {
      await callCurrent('link:delete', { link_id, expected_revision });
      return write(() => {
        deps.assertCurrentCommit('availability:link:delete', { link_id, expected_revision });
        const link = assertLink(link_id);
        if (link.revision !== expected_revision) throw new AvailabilityLinkError('This availability link changed. Read it again before deleting.', 409, 'revision-conflict');
        const saved = { ...link, state: 'deleted' as const, revision: link.revision + 1, updated_at: iso(deps.now()) };
        deps.store.writeLink(saved); return saved;
      });
    },
    async restore({ link_id, expected_revision }: { link_id: string; expected_revision: number }) {
      await callCurrent('link:restore', { link_id, expected_revision });
      return write(() => {
        deps.assertCurrentCommit('availability:link:restore', { link_id, expected_revision });
        const link = assertLink(link_id);
        if (link.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot be restored.', 409, 'link-deleted');
        if (link.revision !== expected_revision) throw new AvailabilityLinkError('This availability link changed. Read it again before restoring.', 409, 'revision-conflict');
        if (link.expires_at && Date.parse(link.expires_at) <= deps.now()) throw new AvailabilityLinkError('Change the expired link’s end time before restoring it.', 409, 'link-expired');
        const saved = { ...link, state: 'active' as const, revision: link.revision + 1, updated_at: iso(deps.now()) };
        deps.store.writeLink(saved); return saved;
      });
    },
    async recipientRead({ link_id, recipient, from, to }: { link_id: string; recipient: unknown; from?: string; to?: string }) {
      await deps.authorizeRecipient({ operation: 'recipient:read', link_id, recipient });
      const link = assertLink(link_id);
      if (!isLinkOpen(link, deps.now())) throw new AvailabilityLinkError('This availability link has ended.', 410, 'link-ended');
      const range = dateRange(link, { from, to });
      const candidates = slotsFor(link, range.from, range.days, []);
      let busyFrom = Infinity, busyTo = -Infinity;
      for (const slot of candidates) { busyFrom = Math.min(busyFrom, slot.startMs); busyTo = Math.max(busyTo, slot.endMs); }
      const busy = candidates.length ? await readBusy(link, busyFrom - (link.buffer_before_min ?? 0) * 60_000,
        busyTo + (link.buffer_after_min ?? 0) * 60_000) : [];
      await deps.authorizeRecipient({ operation: 'recipient:read', link_id, link, recipient });
      const latest = assertLink(link.id);
      if (!isLinkOpen(latest, deps.now()) || latest.revision !== link.revision) throw new AvailabilityLinkError('This availability link changed while its times were being read. Reload its current times.', 409, 'link-changed');
      return { link: { id: link.id, title: link.title, timezone: link.timezone, duration_min: link.duration_min,
        ...(link.requires_confirmation ? { requires_confirmation: true } : {}),
        ...(link.description ? { description: link.description } : {}), ...(link.location ? { location: link.location } : {}) }, slots: slotsFor(link, range.from, range.days, busy).map(({ free_hosts: _hosts, ...slot }) => slot) };
    },
    async reserve({ link_id, recipient, request_key, start_ms, name, email }: { link_id: string; recipient: unknown; request_key: string; start_ms: number; name?: string; email?: string }) {
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))) throw new AvailabilityLinkError('Use a name of at most 200 characters.');
      if (email !== undefined && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new AvailabilityLinkError('Use a valid email address.');
      const principal = await deps.authorizeRecipient({ operation: 'recipient:reserve', link_id, recipient });
      const key = assertRequestKey(request_key), link = assertLink(link_id);
      // A link that asks for confirmation records a request now; the calendar event is made when the organizer confirms.
      const requestOnly = link.requires_confirmation === true;
      const operationData = operationFor(requestOnly ? 'request' : 'reserve', link.id, key, { link_id, start_ms, ...(name ? { name } : {}), ...(email ? { email } : {}) }, principal?.identity);
      if (operationData.repeated) return recipientReply(await reconcileExisting(operationData.operation, link, assertReservation(operationData.operation.reservation_id)), recipient, 'recipient:reserve');
      if (!isLinkOpen(link, deps.now())) throw new AvailabilityLinkError('This availability link has ended.', 410, 'link-ended');
      if (!Number.isFinite(start_ms)) throw new AvailabilityLinkError('Choose an offered time.');
      const startDay = day(start_ms, link.timezone);
      const bounds = dateRange(link, { from: startDay, to: startDay });
      const busy = await readBusy(link, start_ms - (link.buffer_before_min ?? 0) * 60_000, start_ms + (link.duration_min + (link.buffer_after_min ?? 0)) * 60_000);
      let operation!: AvailabilityOperation, reservation!: AvailabilityReservation;
      let repeated = false;
      write(() => {
        const heldOperation = deps.store.readOperation(operationData.operation.id);
        if (heldOperation) {
          if (heldOperation.identity !== operationData.operation.identity || heldOperation.input_identity !== operationData.operation.input_identity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
          operation = heldOperation; reservation = assertReservation(heldOperation.reservation_id); repeated = true; return;
        }
        const latest = assertLink(link.id);
        if (!isLinkOpen(latest, deps.now()) || latest.revision !== link.revision) throw new AvailabilityLinkError('This availability link changed or ended. Reload its current times.', 409, 'link-changed');
        deps.assertRecipientCommit({ operation: 'recipient:reserve', link: latest, recipient, identity: principal.identity });
        const slots = slotsFor(latest, bounds.from, 0, busy);
        const offered = slots.find(slot => slot.startMs === start_ms);
        if (!offered) throw new AvailabilityLinkError('That time was just taken or is no longer open. Choose another offered time.', 409, 'slot-taken');
        if ((latest.seats_per_slot ?? 1) > 1 && heldBy(latest, offered, principal.identity)) throw new AvailabilityLinkError('You already hold a seat at that time.', 409, 'seat-held');
        const grant = nonempty(principal.grant) ? principal.grant : null;
        if (latest.per_grant_max && grant && deps.store.countGrantReservations({ link_id: latest.id, grant_ref: grant, limit: latest.per_grant_max }) >= latest.per_grant_max) {
          throw new AvailabilityLinkError('This link\'s bookings are all taken. Move or cancel one to choose another time.', 409, 'grant-limit');
        }
        // Hosts who take turns: this booking goes to one host (spread by weight), and is that host's alone from here on.
        const host = takesTurns(latest) ? pickHost(latest, offered) : null;
        reservation = { id: `availability-reservation:${deps.opaqueId()}`, link_id: latest.id, recipient_identity: principal.identity, calendar: structuredClone(host?.calendar ?? latest.calendar), host_calendars: host ? [structuredClone(host.calendar)] : hostCalendars(latest), state: 'pending', start_ms: offered.startMs, end_ms: offered.endMs,
          occupied_start_ms: offered.startMs - (latest.buffer_before_min ?? 0) * 60_000, occupied_end_ms: offered.endMs + (latest.buffer_after_min ?? 0) * 60_000,
          created_at: iso(deps.now()), updated_at: iso(deps.now()), ...(grant ? { grant_ref: grant } : {}), ...(name || email ? { recipient: { ...(name ? { name } : {}), ...(email ? { email } : {}) } } : {}) };
        if (requestOnly) {
          reservation.state = 'requested'; reservation.holds_slot = latest.pending_blocks_slot === true;
          operation = { ...operationData.operation, reservation_id: reservation.id, state: 'completed' };
          reservation.last_operation_id = operation.id;
        } else {
          operation = { ...operationData.operation, reservation_id: reservation.id };
          reservation.pending_operation_id = operation.id; reservation.last_operation_id = operation.id;
          operation.effect_input = { link: structuredClone(host ? linkForReservation(latest, reservation) : latest), reservation: structuredClone(reservation) };
        }
        deps.store.writeOperation(operation); deps.store.writeReservation(reservation);
      });
      if (repeated) return recipientReply(await reconcileExisting(operation, link, reservation), recipient, 'recipient:reserve');
      if (requestOnly) return recipientReply({ operation, reservation }, recipient, 'recipient:reserve');
      const saved = await dispatchFirstEffect(operation, link, reservation);
      return recipientReply(saved, recipient, 'recipient:reserve');
    },
    async readReservation({ reservation_id, recipient }: { reservation_id: string; recipient?: unknown }) {
      if (recipient === undefined) await callCurrent('reservation:read', { reservation_id });
      if (recipient !== undefined) await deps.authorizeRecipient({ operation: 'recipient:reservation-read', reservation_id, recipient });
      const reservation = assertReservation(reservation_id), link = assertLink(reservation.link_id);
      if (recipient !== undefined) { const principal = await deps.authorizeRecipient({ operation: 'recipient:reservation-read', link, reservation, recipient });
        if (principal?.identity !== reservation.recipient_identity) throw new AvailabilityLinkError('That reservation is unavailable.', 403, 'recipient-refused'); }
      const result = { reservation, operation: reservation.last_operation_id ? deps.store.readOperation(reservation.last_operation_id) : null };
      return recipient === undefined ? result : recipientReply(result, recipient, 'recipient:reservation-read');
    },
    async move({ reservation_id, recipient, request_key, start_ms }: { reservation_id: string; recipient: unknown; request_key: string; start_ms: number }) {
      if (!Number.isFinite(start_ms)) throw new AvailabilityLinkError('Choose an offered time.');
      await deps.authorizeRecipient({ operation: 'recipient:move', reservation_id, recipient });
      const reservation = assertReservation(reservation_id), link = assertLink(reservation.link_id);
      const principal = await deps.authorizeRecipient({ operation: 'recipient:move', link, reservation, recipient });
      if (principal?.identity !== reservation.recipient_identity) throw new AvailabilityLinkError('That reservation is unavailable.', 403, 'recipient-refused');
      const key = assertRequestKey(request_key), operationData = operationFor('move', link.id, key, { reservation_id, start_ms }, principal.identity);
      if (operationData.repeated) return recipientReply(await reconcileExisting(operationData.operation, link, reservation), recipient, 'recipient:move');
      if (!isLinkOpen(link, deps.now())) throw new AvailabilityLinkError('This availability link has ended.', 410, 'link-ended');
      if (reservation.state === 'requested') throw new AvailabilityLinkError('This request is waiting for the organizer. Withdraw it to choose another time.', 409, 'reservation-requested');
      if (reservation.state !== 'booked') throw new AvailabilityLinkError('This reservation cannot be moved while its calendar change is unresolved.', 409, 'reservation-pending');
      if (!changeOpen(link, reservation, principal, deps.now())) throw new AvailabilityLinkError(`This booking can be moved only until ${link.change_notice_min} minutes before it starts.`, 409, 'change-closed');
      const meetingLink = linkForReservation(link, reservation);
      const startDay = day(start_ms, link.timezone), bounds = dateRange(link, { from: startDay, to: startDay });
      const busy = await readBusy(meetingLink, start_ms - (link.buffer_before_min ?? 0) * 60_000, start_ms + (link.duration_min + (link.buffer_after_min ?? 0)) * 60_000, reservation);
      let operation!: AvailabilityOperation, currentReservation = reservation, repeated = false;
      write(() => {
        const heldOperation = deps.store.readOperation(operationData.operation.id);
        if (heldOperation) {
          if (heldOperation.identity !== operationData.operation.identity || heldOperation.input_identity !== operationData.operation.input_identity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
          operation = heldOperation; currentReservation = assertReservation(heldOperation.reservation_id); repeated = true; return;
        }
        const latest = assertReservation(reservation.id), latestLink = assertLink(link.id);
        if (latest.state !== 'booked' || latest.pending_operation_id) throw new AvailabilityLinkError('This reservation changed. Read it again before moving.', 409, 'reservation-changed');
        if (!isLinkOpen(latestLink, deps.now())) throw new AvailabilityLinkError('This availability link has ended.', 410, 'link-ended');
        if (latestLink.revision !== link.revision) throw new AvailabilityLinkError('This availability link changed. Read it again before moving.', 409, 'link-changed');
        deps.assertRecipientCommit({ operation: 'recipient:move', link: latestLink, reservation: latest, recipient, identity: principal.identity });
        const originalLink = linkForReservation(latestLink, latest);
        const offered = slotsFor(originalLink, bounds.from, 0, busy, latest.id).find(slot => slot.startMs === start_ms);
        if (!offered) throw new AvailabilityLinkError('That time was just taken or is no longer open.', 409, 'slot-taken');
        operation = { ...operationData.operation, reservation_id: latest.id, requested_start_ms: offered.startMs, requested_end_ms: offered.endMs };
        const pending = { ...latest, pending_operation_id: operation.id, last_operation_id: operation.id, pending_start_ms: offered.startMs, pending_end_ms: offered.endMs,
          pending_host_calendars: structuredClone(latest.host_calendars?.length ? latest.host_calendars : [latest.calendar]),
          pending_occupied_start_ms: offered.startMs - (latestLink.buffer_before_min ?? 0) * 60_000, pending_occupied_end_ms: offered.endMs + (latestLink.buffer_after_min ?? 0) * 60_000, updated_at: iso(deps.now()) };
        operation.effect_input = { link: structuredClone(linkForReservation(latestLink, pending)), reservation: structuredClone(pending) };
        deps.store.writeOperation(operation); deps.store.writeReservation(pending);
      });
      if (repeated) return recipientReply(await reconcileExisting(operation, link, currentReservation), recipient, 'recipient:move');
      return recipientReply(await dispatchFirstEffect(operation, link, { ...currentReservation, pending_operation_id: operation.id, pending_start_ms: operation.requested_start_ms, pending_end_ms: operation.requested_end_ms }), recipient, 'recipient:move');
    },
    async cancel({ reservation_id, recipient, request_key }: { reservation_id: string; recipient: unknown; request_key: string }) {
      await deps.authorizeRecipient({ operation: 'recipient:cancel', reservation_id, recipient });
      const reservation = assertReservation(reservation_id), link = assertLink(reservation.link_id);
      const principal = await deps.authorizeRecipient({ operation: 'recipient:cancel', link, reservation, recipient });
      if (principal?.identity !== reservation.recipient_identity) throw new AvailabilityLinkError('That reservation is unavailable.', 403, 'recipient-refused');
      const key = assertRequestKey(request_key), operationData = operationFor('cancel', link.id, key, { reservation_id }, principal.identity);
      if (operationData.repeated) return recipientReply(await reconcileExisting(operationData.operation, link, reservation), recipient, 'recipient:cancel');
      if (reservation.state === 'cancelled') {
        const completed = { ...operationData.operation, reservation_id: reservation.id, state: 'completed' as const, updated_at: iso(deps.now()) };
        write(() => { if (!deps.store.readOperation(completed.id)) deps.store.writeOperation(completed); });
        return recipientReply({ reservation, operation: deps.store.readOperation(completed.id) ?? completed }, recipient, 'recipient:cancel');
      }
      if (reservation.state === 'requested') {
        const ended = endRequest(reservation.id, { ...operationData.operation, reservation_id: reservation.id }, 'recipient', 'withdrawn',
          latest => deps.assertRecipientCommit({ operation: 'recipient:cancel', link, reservation: latest, recipient, identity: principal.identity }));
        return recipientReply(ended, recipient, 'recipient:cancel');
      }
      if (reservation.state !== 'booked') throw new AvailabilityLinkError('This reservation cannot be cancelled while its calendar change is unresolved.', 409, 'reservation-pending');
      if (!changeOpen(link, reservation, principal, deps.now())) throw new AvailabilityLinkError(`This booking can be cancelled only until ${link.change_notice_min} minutes before it starts.`, 409, 'change-closed');
      let operation!: AvailabilityOperation, currentReservation = reservation, repeated = false;
      write(() => {
        const heldOperation = deps.store.readOperation(operationData.operation.id);
        if (heldOperation) {
          if (heldOperation.identity !== operationData.operation.identity || heldOperation.input_identity !== operationData.operation.input_identity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
          operation = heldOperation; currentReservation = assertReservation(heldOperation.reservation_id); repeated = true; return;
        }
        const latest = assertReservation(reservation.id);
        if (latest.state !== 'booked' || latest.pending_operation_id) throw new AvailabilityLinkError('This reservation changed. Read it again before cancelling.', 409, 'reservation-changed');
        deps.assertRecipientCommit({ operation: 'recipient:cancel', link, reservation: latest, recipient, identity: principal.identity });
        operation = { ...operationData.operation, reservation_id: latest.id };
        const pending = { ...latest, pending_operation_id: operation.id, last_operation_id: operation.id, updated_at: iso(deps.now()) };
        operation.effect_input = { link: structuredClone(linkForReservation(link, pending)), reservation: structuredClone(pending) };
        deps.store.writeOperation(operation); deps.store.writeReservation(pending);
      });
      if (repeated) return recipientReply(await reconcileExisting(operation, link, currentReservation), recipient, 'recipient:cancel');
      return recipientReply(await dispatchFirstEffect(operation, link, { ...currentReservation, pending_operation_id: operation.id }), recipient, 'recipient:cancel');
    },
    /** The organizer's side of a link that asks for confirmation. A request waiting for an answer becomes a reservation
     * (the calendar event is made now, and the time must still be open); `decline` ends it and frees its time. Retrying
     * either with the same request_key returns the same outcome. */
    async confirm({ reservation_id, request_key }: { reservation_id: string; request_key: string }) {
      await callCurrent('reservation:confirm', { reservation_id });
      const key = assertRequestKey(request_key), reservation = assertReservation(reservation_id), link = assertLink(reservation.link_id);
      const operationData = operationFor('reserve', link.id, key, { reservation_id, confirm: true }, organizerIdentity);
      if (operationData.repeated) return reconcileExisting(operationData.operation, link, assertReservation(operationData.operation.reservation_id));
      if (reservation.state !== 'requested') throw new AvailabilityLinkError('Only a request that is still waiting can be confirmed. Read it again.', 409, 'reservation-changed');
      if (link.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot take a meeting.', 409, 'link-deleted');
      if (reservation.start_ms <= deps.now()) throw new AvailabilityLinkError('This request is for a time that has passed. Decline it.', 409, 'request-expired');
      // The request was made inside the link's notice and horizon; the organizer answering later is not held to the notice again.
      const asked = linkForReservation({ ...link, min_notice_min: 0 }, reservation);
      const startDay = day(reservation.start_ms, link.timezone);
      const bounds = dateRange(asked, { from: startDay, to: startDay });
      const busy = await readBusy(asked, reservation.start_ms - (link.buffer_before_min ?? 0) * 60_000, reservation.end_ms + (link.buffer_after_min ?? 0) * 60_000);
      let operation!: AvailabilityOperation, pending!: AvailabilityReservation, repeated = false;
      write(() => {
        deps.assertCurrentCommit('availability:reservation:confirm', { reservation_id });
        const heldOperation = deps.store.readOperation(operationData.operation.id);
        if (heldOperation) {
          if (heldOperation.identity !== operationData.operation.identity || heldOperation.input_identity !== operationData.operation.input_identity) throw new AvailabilityLinkError('Reuse this request_key only for the same availability change.', 409, 'request-key-reused');
          operation = heldOperation; pending = assertReservation(heldOperation.reservation_id); repeated = true; return;
        }
        const latest = assertReservation(reservation.id), latestLink = assertLink(link.id);
        if (latest.state !== 'requested') throw new AvailabilityLinkError('This request changed. Read it again before confirming.', 409, 'reservation-changed');
        if (latestLink.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot take a meeting.', 409, 'link-deleted');
        if (!slotsFor(linkForReservation({ ...latestLink, min_notice_min: 0 }, latest), bounds.from, 0, busy, latest.id).some(slot => slot.startMs === latest.start_ms)) {
          throw new AvailabilityLinkError('That time was taken or is no longer open. Decline the request or ask for another time.', 409, 'slot-taken');
        }
        operation = { ...operationData.operation, reservation_id: latest.id };
        pending = { ...latest, state: 'pending', holds_slot: undefined, pending_operation_id: operation.id, last_operation_id: operation.id, updated_at: iso(deps.now()) };
        operation.effect_input = { link: structuredClone(takesTurns(latestLink) ? linkForReservation(latestLink, pending) : latestLink), reservation: structuredClone(pending) };
        deps.store.writeOperation(operation); deps.store.writeReservation(pending);
      });
      if (repeated) return reconcileExisting(operation, link, pending);
      return dispatchFirstEffect(operation, link, pending);
    },
    async decline({ reservation_id, request_key }: { reservation_id: string; request_key: string }) {
      await callCurrent('reservation:decline', { reservation_id });
      const key = assertRequestKey(request_key), reservation = assertReservation(reservation_id), link = assertLink(reservation.link_id);
      const operationData = operationFor('cancel', link.id, key, { reservation_id, declined: true }, organizerIdentity);
      return endRequest(reservation.id, { ...operationData.operation, reservation_id: reservation.id }, 'organizer', 'declined',
        () => deps.assertCurrentCommit('availability:reservation:decline', { reservation_id }));
    },
    /** One page of a link's reservations (optionally only those in `state`, such as the requests waiting for an answer). */
    async reservations({ link_id, state, after, limit = 25 }: { link_id: string; state?: ReservationState; after?: string | null; limit?: number }) {
      await callCurrent('reservation:list', { link_id });
      assertLink(link_id);
      if (typeof deps.store.reservationsOfLink !== 'function') throw new AvailabilityLinkError('This store cannot list a link\'s reservations.', 501, 'not-implemented');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new AvailabilityLinkError('Choose a page size of at least 1.');
      const page = deps.store.reservationsOfLink({ link_id, after: after ?? null, limit: Math.min(limit, maxList) });
      return { reservations: page.rows.map(row => row.reservation).filter((row): row is AvailabilityReservation => Boolean(row) && (state === undefined || row!.state === state)), next_cursor: page.next };
    },
    /** The organizer takes a meeting already on the link's calendar (`external_event_id`, booked somewhere else) into the
     * link as a booked reservation: no calendar change is sent. Its interval must be free of the link's other held
     * reservations, and it counts toward `grant_ref`'s per_grant_max. The same event adopted again answers the same
     * reservation. */
    async adopt({ link_id, start_ms, external_event_id, recipient_identity, grant_ref, name, email }: { link_id: string; start_ms: number; external_event_id: string; recipient_identity: string; grant_ref?: string; name?: string; email?: string }) {
      await callCurrent('reservation:adopt', { link_id, start_ms, external_event_id });
      if (!Number.isSafeInteger(start_ms)) throw new AvailabilityLinkError('Give the meeting start in milliseconds.');
      if (!nonempty(external_event_id) || external_event_id.length > 500) throw new AvailabilityLinkError('Name the calendar event this meeting already is.');
      if (!nonempty(recipient_identity)) throw new AvailabilityLinkError('Name who the meeting is with.', 400, 'recipient-unverified');
      if (grant_ref !== undefined && !nonempty(grant_ref)) throw new AvailabilityLinkError('A grant reference must be nonempty.');
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) throw new AvailabilityLinkError('Use a name of at most 200 characters.');
      if (email !== undefined && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new AvailabilityLinkError('Use a valid email address.');
      const id = `availability-reservation:${deps.identity({ adopted: [link_id, external_event_id] })}`;
      return write(() => {
        deps.assertCurrentCommit('availability:reservation:adopt', { link_id, external_event_id });
        const held = deps.store.readReservation(id);
        if (held) return held;
        const link = assertLink(link_id);
        if (link.state === 'deleted') throw new AvailabilityLinkError('A deleted availability link cannot take a meeting.', 409, 'link-deleted');
        const end_ms = start_ms + link.duration_min * 60_000;
        const occupied = { start: start_ms - (link.buffer_before_min ?? 0) * 60_000, end: end_ms + (link.buffer_after_min ?? 0) * 60_000 };
        const page = deps.store.queryReservations({ calendar: link.calendar, calendars: hostCalendars(link), from_ms: occupied.start, to_ms: occupied.end, limit: maxHeld });
        if (!page?.complete) throw new AvailabilityLinkError('This time has more reservations than one read can verify.', 503, 'reservation-read-incomplete');
        if (page.reservations.some(row => occupying(row))) throw new AvailabilityLinkError('Another booking already holds that time.', 409, 'slot-taken');
        if (link.per_grant_max && grant_ref && deps.store.countGrantReservations({ link_id: link.id, grant_ref, limit: link.per_grant_max }) >= link.per_grant_max) {
          throw new AvailabilityLinkError('This grant already holds every booking the link allows.', 409, 'grant-limit');
        }
        const now = iso(deps.now());
        const reservation: AvailabilityReservation = { id, link_id: link.id, recipient_identity, calendar: structuredClone(link.calendar), host_calendars: hostCalendars(link),
          state: 'booked', start_ms, end_ms, occupied_start_ms: occupied.start, occupied_end_ms: occupied.end, created_at: now, updated_at: now,
          external_event_id, ...(grant_ref ? { grant_ref } : {}), ...(name || email ? { recipient: { ...(name ? { name } : {}), ...(email ? { email } : {}) } } : {}) };
        deps.store.writeReservation(reservation);
        return reservation;
      });
    },
    async reconcile({ operation_id, recipient }: { operation_id: string; recipient?: unknown }) {
      if (recipient === undefined) await callCurrent('reconcile', { operation_id });
      else await deps.authorizeRecipient({ operation: 'recipient:reconcile', operation_id, recipient });
      const operation = deps.store.readOperation(operation_id);
      if (!operation) throw new AvailabilityLinkError('That availability operation is unavailable.', 404, 'not-found');
      const link = assertLink(operation.link_id), reservation = assertReservation(operation.reservation_id);
      if (recipient !== undefined) { const principal = await deps.authorizeRecipient({ operation: 'recipient:reconcile', link, reservation, recipient });
        if (principal?.identity !== reservation.recipient_identity) throw new AvailabilityLinkError('That reservation is unavailable.', 403, 'recipient-refused'); }
      const result = await reconcileExisting(operation, link, reservation);
      return recipient === undefined ? result : recipientReply(result, recipient, 'recipient:reconcile');
    },
  });
}

