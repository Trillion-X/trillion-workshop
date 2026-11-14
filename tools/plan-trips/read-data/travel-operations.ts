// package-set://bitfield-studio/packages/travel-operations/read-data/travel-operations.ts

export type TripLaneId = 'itinerary' | 'packing' | 'bookings';
export type TripPriority = 'critical' | 'high' | 'normal' | 'low' | 'done';

export interface TripSourceRef {
  package: string;
  type: string;
  id: string;
}

export interface TripAction {
  id: string;
  ownerPackage: string;
  actionDefinitionId: string;
  target?: string;
  label: string;
  input: Record<string, unknown>;
  targetStateDescriptor?: string;
  supportRefs: string[];
}

export interface TripItem {
  id: string;
  lane: TripLaneId;
  title: string;
  status: string;
  reason: string;
  detail: string[];
  timeLabel?: string;
  priority: TripPriority;
  privacyClass: string;
  sortKey: string;
  source: TripSourceRef;
  action?: TripAction;
}

export interface TripLane {
  id: TripLaneId;
  label: string;
  count: number;
  openCount: number;
}

export interface TravelNote {
  id: string;
  sourceKind: string;
  sourceRef: string;
  contentAddressRef?: string;
  capturedAt?: string;
  capturedBy?: string;
  payload?: Record<string, unknown>;
  sensitiveFieldRefs: string[];
  candidateFactRefs: string[];
}

export interface TravelCandidateFact {
  id: string;
  targetOwnerPackage: string;
  targetRecordRef: string;
  operationKind: string;
  proposedPatch: Record<string, unknown>;
  sourceEvidenceRefs: string[];
  confidence: number;
  reviewState: string;
  reviewReason: string;
  createdAt?: string;
}

export interface TravelNotesState {
  evidence: TravelNote[];
  candidateFacts: TravelCandidateFact[];
}

export interface TravelOperationsInput {
  itineraryRaw?: unknown;
  packingListRaw?: unknown;
  reservationRaw?: unknown;
  notesRaw?: unknown;
  evidenceRaw?: unknown;
  items?: TripItem[];
  notes?: TravelNote[];
  candidateFacts?: TravelCandidateFact[];
}

export interface TravelOwnerStates {
  itinerary: Record<string, unknown>;
  packingList: Record<string, unknown>;
  reservations: Record<string, unknown>[];
}

export type TripCreateLane = TripLaneId;

export interface TripCreateAction {
  id: string;
  lane: TripCreateLane;
  ownerPackage: string;
  actionDefinitionId: string;
  label: string;
  input: Record<string, unknown> | Record<string, unknown>[];
  supportRefs: string[];
}

export interface TravelOperationsModel extends TravelNotesState {
  tripName: string;
  items: TripItem[];
  focus: TripItem | null;
  later: TripItem[];
  lanes: TripLane[];
  ownerStates: TravelOwnerStates;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function field(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return row[camel] ?? row[snake];
}

function optionalText(row: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = text(field(row, camel, snake)).trim();
  return value || undefined;
}

function textList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function words(value: string): string {
  return value
    .replace(/[-_:.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value: string): string {
  const clean = words(value);
  if (!clean) return '';
  return clean.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(value: string, fallback: string): string {
  return titleCase(value || fallback);
}

function priorityRank(priority: TripPriority): number {
  if (priority === 'critical') return 0;
  if (priority === 'high') return 1;
  if (priority === 'normal') return 2;
  if (priority === 'low') return 3;
  return 9;
}

function isOpen(item: TripItem): boolean {
  return item.priority !== 'done';
}

function compareTripItems(a: TripItem, b: TripItem): number {
  return priorityRank(a.priority) - priorityRank(b.priority)
    || a.sortKey.localeCompare(b.sortKey)
    || a.id.localeCompare(b.id);
}

function safeDetail(values: readonly (string | undefined)[]): string[] {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(words)
    .filter((value) => value.length > 0);
}

function readTripName(raw: unknown): string {
  const root = object(raw);
  const firstTrip = object(list(root.trips)[0]);
  return text(firstTrip.name).trim() || 'Trip';
}

function cloneRows(value: unknown): Record<string, unknown>[] {
  return list(value).map((entry) => ({ ...object(entry) }));
}

function normalizeItineraryState(raw: unknown): Record<string, unknown> {
  const root = object(raw);
  return {
    ...root,
    trips: cloneRows(root.trips),
    days: cloneRows(root.days),
    items: cloneRows(root.items),
  };
}

function normalizePackingListState(raw: unknown): Record<string, unknown> {
  const root = object(raw);
  return {
    ...root,
    id: text(root.id).trim() || 'packing-list:default',
    tripRef: text(field(root, 'tripRef', 'trip_ref')),
    name: text(root.name).trim() || 'Packing',
    items: cloneRows(root.items),
  };
}

function normalizeReservationsState(raw: unknown): Record<string, unknown>[] {
  return cloneRows(Array.isArray(raw) ? raw : object(raw).reservations);
}

function normalizeOwnerStates(input: TravelOperationsInput): TravelOwnerStates {
  return {
    itinerary: normalizeItineraryState(input.itineraryRaw),
    packingList: normalizePackingListState(input.packingListRaw),
    reservations: normalizeReservationsState(input.reservationRaw),
  };
}

function buildItineraryItems(raw: unknown): TripItem[] {
  const root = object(raw);
  const days = list(root.days).map((entry) => {
    const row = object(entry);
    return {
      id: text(row.id),
      sequence: number(row.sequence),
      localDate: text(field(row, 'localDate', 'local_date')),
    };
  }).filter((day) => day.id);
  const dayById = new Map(days.map((day) => [day.id, day]));

  return list(root.items).map((entry): TripItem | null => {
    const row = object(entry);
    const id = text(row.id);
    if (!id) return null;
    const day = dayById.get(text(field(row, 'tripDayId', 'trip_day_id')));
    const title = text(row.title).trim() || 'Trip stop';
    const startsAt = optionalText(row, 'startsAt', 'starts_at');
    const endsAt = optionalText(row, 'endsAt', 'ends_at');
    const reservationRef = optionalText(row, 'reservationRef', 'reservation_ref');
    const kind = text(row.kind) || 'plan';
    const priority: TripPriority = reservationRef ? 'normal' : 'low';
    return {
      id: `trip-item:itinerary:${id}`,
      lane: 'itinerary',
      title,
      status: startsAt ? `Starts ${startsAt}` : 'Scheduled',
      reason: reservationRef ? 'Booking linked.' : 'On the schedule.',
      detail: safeDetail([titleCase(kind), day?.localDate, startsAt && endsAt ? `${startsAt} - ${endsAt}` : startsAt]),
      ...(startsAt ? { timeLabel: startsAt } : {}),
      priority,
      privacyClass: 'personal',
      sortKey: `${day?.sequence.toString().padStart(4, '0') ?? '9999'}:${startsAt ?? '99:99'}:${id}`,
      source: { package: 'itinerary', type: 'itinerary_item', id },
      action: {
        id: `transition:itinerary:update:${id}`,
        ownerPackage: 'itinerary',
        actionDefinitionId: 'action:itinerary:update',
        label: 'Update',
        input: { itemId: id, tripDayId: text(field(row, 'tripDayId', 'trip_day_id')) },
        supportRefs: [reservationRef].filter((value): value is string => Boolean(value)),
      },
    };
  }).filter((item): item is TripItem => item !== null);
}

function packingPriority(status: string): TripPriority {
  if (status === 'missing') return 'high';
  if (status === 'packed' || status === 'acquired' || status === 'not-needed') return 'done';
  return 'normal';
}

function buildPackingItems(raw: unknown): TripItem[] {
  const root = object(raw);
  return list(root.items).map((entry): TripItem | null => {
    const row = object(entry);
    const id = text(row.id);
    if (!id) return null;
    const status = text(row.status) || 'planned';
    const priority = packingPriority(status);
    const label = text(row.label).trim() || 'Packing item';
    const category = text(row.category) || 'Packing';
    return {
      id: `trip-item:packing:${id}`,
      lane: 'packing',
      title: label,
      status: statusLabel(status, 'planned'),
      reason: status === 'missing' ? 'Still missing.' : status === 'planned' ? 'Not packed yet.' : 'Packed.',
      detail: safeDetail([category]),
      priority,
      privacyClass: 'personal',
      sortKey: `${priorityRank(priority)}:${category}:${label}:${id}`,
      source: { package: 'packing-list', type: 'packing_item', id },
      ...(priority !== 'done'
        ? {
          action: {
            id: `transition:packing-list:pack:${id}`,
            ownerPackage: 'packing-list',
            actionDefinitionId: 'action:packing-list:update-status',
            label: 'Mark packed',
            input: { itemId: id, status: 'packed' },
            targetStateDescriptor: 'packing-list.state.packed',
            supportRefs: textList(field(row, 'dependencyRefs', 'dependency_refs')),
          },
        }
        : {}),
    };
  }).filter((item): item is TripItem => item !== null);
}

function bookingPriority(status: string): TripPriority {
  if (status === 'changed' || status === 'cancelled') return 'critical';
  if (status === 'requested' || status === 'held') return 'high';
  if (status === 'completed') return 'done';
  return 'normal';
}

function buildBookingItems(raw: unknown): TripItem[] {
  const source = Array.isArray(raw) ? raw : list(object(raw).reservations);
  return source.map((entry): TripItem | null => {
    const row = object(entry);
    const id = text(row.id);
    if (!id) return null;
    const status = text(row.status) || 'idea';
    const priority = bookingPriority(status);
    const title = text(row.title).trim() || 'Booking';
    const startsAt = optionalText(row, 'startsAt', 'starts_at');
    const endsAt = optionalText(row, 'endsAt', 'ends_at');
    const kind = text(row.kind) || 'booking';
    return {
      id: `trip-item:bookings:${id}`,
      lane: 'bookings',
      title,
      status: statusLabel(status, 'tracked'),
      reason: status === 'changed'
        ? 'Review booking.'
        : status === 'held' || status === 'requested'
          ? 'Needs confirmation.'
          : 'Ready.',
      detail: safeDetail([titleCase(kind), startsAt && endsAt ? `${startsAt} - ${endsAt}` : startsAt]),
      ...(startsAt ? { timeLabel: startsAt } : {}),
      priority,
      privacyClass: optionalText(row, 'confirmationCode', 'confirmation_code') ? 'sensitive' : 'personal',
      sortKey: `${priorityRank(priority)}:${startsAt ?? ''}:${title}:${id}`,
      source: { package: 'reservation-tracker', type: 'reservation', id },
      ...(status !== 'confirmed'
        ? {
          action: {
            id: `transition:reservation-tracker:confirm:${id}`,
            ownerPackage: 'reservation-tracker',
            actionDefinitionId: 'action:reservation-tracker:update-status',
            label: 'Mark confirmed',
            input: { reservationId: id, status: 'confirmed' },
            targetStateDescriptor: 'reservation-tracker.state.confirmed',
            supportRefs: [],
          },
        }
        : {}),
    };
  }).filter((item): item is TripItem => item !== null);
}

function decodeTravelNote(raw: unknown): TravelNote | null {
  const row = object(raw);
  const id = text(row.id);
  const sourceKind = text(field(row, 'sourceKind', 'source_kind'));
  const sourceRef = text(field(row, 'sourceRef', 'source_ref'));
  if (!id || !sourceKind || !sourceRef) return null;
  const payload = object(row.payload);
  return {
    id,
    sourceKind,
    sourceRef,
    contentAddressRef: optionalText(row, 'contentAddressRef', 'content_address_ref'),
    capturedAt: optionalText(row, 'capturedAt', 'captured_at'),
    capturedBy: optionalText(row, 'capturedBy', 'captured_by'),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
    sensitiveFieldRefs: textList(field(row, 'sensitiveFieldRefs', 'sensitive_field_refs')),
    candidateFactRefs: textList(field(row, 'candidateFactRefs', 'candidate_fact_refs')),
  };
}

function decodeCandidateFact(raw: unknown): TravelCandidateFact | null {
  const row = object(raw);
  const id = text(row.id);
  const targetOwnerPackage = text(field(row, 'targetOwnerPackage', 'target_owner_package'));
  const targetRecordRef = text(field(row, 'targetRecordRef', 'target_record_ref'));
  if (!id || !targetOwnerPackage || !targetRecordRef) return null;
  return {
    id,
    targetOwnerPackage,
    targetRecordRef,
    operationKind: text(field(row, 'operationKind', 'operation_kind')),
    proposedPatch: object(field(row, 'proposedPatch', 'proposed_patch')),
    sourceEvidenceRefs: textList(field(row, 'sourceEvidenceRefs', 'source_evidence_refs')),
    confidence: number(row.confidence),
    reviewState: text(field(row, 'reviewState', 'review_state')),
    reviewReason: text(field(row, 'reviewReason', 'review_reason')),
    createdAt: optionalText(row, 'createdAt', 'created_at'),
  };
}

export function decodeTravelNotesState(raw: unknown): TravelNotesState {
  const row = object(raw);
  return {
    evidence: list(row.evidence ?? row.notes).map(decodeTravelNote).filter((entry): entry is TravelNote => entry !== null),
    candidateFacts: list(row.candidateFacts ?? row.candidate_facts).map(decodeCandidateFact).filter((entry): entry is TravelCandidateFact => entry !== null),
  };
}

function compareNotes(a: { capturedAt?: string; id: string }, b: { capturedAt?: string; id: string }): number {
  return (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '') || a.id.localeCompare(b.id);
}

function uniqueById<T extends { id: string }>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values()).sort(compare);
}

export function appendTravelNotesState(
  current: TravelNotesState,
  update: Partial<TravelNotesState>,
): TravelNotesState {
  return {
    evidence: uniqueById([...current.evidence, ...(update.evidence ?? [])], compareNotes),
    candidateFacts: uniqueById(
      [...current.candidateFacts, ...(update.candidateFacts ?? [])],
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id),
    ),
  };
}

function buildLanes(items: readonly TripItem[]): TripLane[] {
  const laneLabels: Record<TripLaneId, string> = {
    itinerary: 'Itinerary',
    packing: 'Packing',
    bookings: 'Bookings',
  };
  return (Object.keys(laneLabels) as TripLaneId[]).map((id) => {
    const laneItems = items.filter((item) => item.lane === id);
    return {
      id,
      label: laneLabels[id],
      count: laneItems.length,
      openCount: laneItems.filter(isOpen).length,
    };
  });
}

export function buildTravelOperationsModel(input: TravelOperationsInput): TravelOperationsModel {
  const ownerStates = normalizeOwnerStates(input);
  const items = [
    ...buildItineraryItems(ownerStates.itinerary),
    ...buildPackingItems(ownerStates.packingList),
    ...buildBookingItems(ownerStates.reservations),
    ...(input.items ?? []),
  ].sort(compareTripItems);
  const notesState = appendTravelNotesState(decodeTravelNotesState(input.notesRaw ?? input.evidenceRaw), {
    evidence: input.notes,
    candidateFacts: input.candidateFacts,
  });
  const openItems = items.filter(isOpen);
  const focus = openItems[0] ?? null;
  return {
    tripName: readTripName(input.itineraryRaw),
    items,
    focus,
    later: focus ? openItems.filter((item) => item.id !== focus.id) : openItems,
    lanes: buildLanes(items),
    ownerStates,
    evidence: notesState.evidence,
    candidateFacts: notesState.candidateFacts,
  };
}

function slug(value: string): string {
  return words(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
}

function createSuffix(title: string, createdAt: string): string {
  return `${slug(title)}-${createdAt.replace(/[^0-9a-z]/gi, '').slice(0, 14)}`;
}

function firstDateLabel(value: string): string {
  const match = value.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return match?.[0] ?? '';
}

function maxSequence(days: readonly Record<string, unknown>[]): number {
  return days.reduce((max, day) => Math.max(max, number(day.sequence)), 0);
}

function ensureTrip(state: Record<string, unknown>): string {
  const trips = cloneRows(state.trips);
  const currentTrip = object(trips[0]);
  const id = text(currentTrip.id).trim() || 'trip:default';
  if (trips.length === 0) {
    trips.push({ id, name: 'Trip', travelerRefs: ['traveler:owner'] });
    state.trips = trips;
  }
  return id;
}

function ensureDay(state: Record<string, unknown>, dateLabel: string): string | undefined {
  if (!dateLabel) return undefined;
  const tripId = ensureTrip(state);
  const days = cloneRows(state.days);
  const existing = days.find((day) => text(field(day, 'localDate', 'local_date')) === dateLabel);
  if (existing) return text(existing.id) || undefined;
  const dayId = `day:${dateLabel}`;
  days.push({ id: dayId, tripId, sequence: maxSequence(days) + 1, localDate: dateLabel });
  state.days = days;
  return dayId;
}

export function buildTripCreateAction(input: {
  model: TravelOperationsModel;
  lane: TripCreateLane;
  title: string;
  detail?: string;
  createdAt?: string;
}): TripCreateAction {
  const title = input.title.trim();
  if (!title) throw new Error('Add a trip thing first.');
  const detail = input.detail?.trim() ?? '';
  const createdAt = input.createdAt ?? new Date().toISOString();
  const suffix = createSuffix(title, createdAt);

  if (input.lane === 'itinerary') {
    const itinerary = normalizeItineraryState(input.model.ownerStates.itinerary);
    const dateLabel = firstDateLabel(detail);
    const tripDayId = ensureDay(itinerary, dateLabel);
    const items = cloneRows(itinerary.items);
    items.push({
      id: `item:${suffix}`,
      ...(tripDayId ? { tripDayId } : {}),
      kind: 'custom',
      title,
      ...(detail ? { startsAt: detail } : {}),
      taskRefs: [],
    });
    itinerary.items = items;
    ensureTrip(itinerary);
    return {
      id: `create:itinerary:${suffix}`,
      lane: 'itinerary',
      ownerPackage: 'itinerary',
      actionDefinitionId: 'action:itinerary:update',
      label: 'Add itinerary',
      input: itinerary,
      supportRefs: [],
    };
  }

  if (input.lane === 'packing') {
    const packingList = normalizePackingListState(input.model.ownerStates.packingList);
    const listId = text(packingList.id).trim() || 'packing-list:default';
    const items = cloneRows(packingList.items);
    items.push({
      id: `pack:${suffix}`,
      listId,
      label: title,
      category: detail || 'General',
      status: 'planned',
      quantity: { count: 1 },
    });
    packingList.id = listId;
    packingList.items = items;
    return {
      id: `create:packing:${suffix}`,
      lane: 'packing',
      ownerPackage: 'packing-list',
      actionDefinitionId: 'action:packing-list:update',
      label: 'Add packing',
      input: packingList,
      supportRefs: [],
    };
  }

  const reservations = normalizeReservationsState(input.model.ownerStates.reservations);
  reservations.push({
    id: `reservation:${suffix}`,
    kind: 'custom',
    title,
    status: 'idea',
    ...(detail ? { startsAt: detail } : {}),
    taskRefs: [],
  });
  return {
    id: `create:bookings:${suffix}`,
    lane: 'bookings',
    ownerPackage: 'reservation-tracker',
    actionDefinitionId: 'action:reservation-tracker:update',
    label: 'Add booking',
    input: reservations,
    supportRefs: [],
  };
}

export function buildTripNote(input: {
  id: string;
  sourceKind: string;
  sourceRef: string;
  capturedAt?: string;
  capturedBy?: string;
  text?: string;
}): TravelNote {
  const cleanText = input.text?.trim();
  return {
    id: input.id,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    capturedAt: input.capturedAt,
    capturedBy: input.capturedBy,
    ...(cleanText ? { payload: { text: cleanText } } : {}),
    sensitiveFieldRefs: [],
    candidateFactRefs: [],
  };
}
