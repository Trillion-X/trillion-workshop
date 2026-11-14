// package-set://bitfield-studio/packages/itinerary/read-data/itinerary.ts

import type { OperationRecord } from '../../operation-records/read-data/operation-records.ts';

export type ItineraryItemKind = string;

export interface Trip {
  id: string;
  name: string;
  travelerRefs: string[];
  timezonePolicy?: string;
  configRefs: string[];
}

export interface TripDay {
  id: string;
  tripId: string;
  sequence: number;
  localDate: string;
  title?: string;
}

export interface ItineraryItem {
  id: string;
  tripDayId: string;
  kind: ItineraryItemKind;
  title: string;
  startsAt?: string;
  endsAt?: string;
  placeRef?: string;
  reservationRef?: string;
  taskRefs: string[];
  journalNoteRef?: string;
  dependencyRefs: string[];
}

export interface Itinerary {
  trips: Trip[];
  days: TripDay[];
  items: ItineraryItem[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueAt(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return row[camel] ?? row[snake];
}

function optionalString(row: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = string(valueAt(row, camel, snake));
  return value || undefined;
}

function itemKind(value: unknown): ItineraryItemKind {
  return string(value) || 'custom';
}

export function decodeItinerary(raw: unknown): Itinerary {
  const root = object(raw);
  return {
    trips: array(root.trips).map((entry) => {
      const row = object(entry);
      const timezonePolicy = optionalString(row, 'timezonePolicy', 'timezone_policy');
      return {
        id: string(row.id),
        name: string(row.name),
        travelerRefs: stringArray(valueAt(row, 'travelerRefs', 'traveler_refs')),
        configRefs: stringArray(valueAt(row, 'configRefs', 'config_refs')),
        ...(timezonePolicy ? { timezonePolicy } : {}),
      };
    }).filter((trip) => trip.id),
    days: array(root.days).map((entry) => {
      const row = object(entry);
      const title = optionalString(row, 'title');
      return {
        id: string(row.id),
        tripId: string(valueAt(row, 'tripId', 'trip_id')),
        sequence: number(row.sequence),
        localDate: string(valueAt(row, 'localDate', 'local_date')),
        ...(title ? { title } : {}),
      };
    }).filter((day) => day.id),
    items: array(root.items).map((entry) => {
      const row = object(entry);
      const startsAt = optionalString(row, 'startsAt', 'starts_at');
      const endsAt = optionalString(row, 'endsAt', 'ends_at');
      const placeRef = optionalString(row, 'placeRef', 'place_ref');
      const reservationRef = optionalString(row, 'reservationRef', 'reservation_ref');
      const journalNoteRef = optionalString(row, 'journalNoteRef', 'journal_note_ref');
      return {
        id: string(row.id),
        tripDayId: string(valueAt(row, 'tripDayId', 'trip_day_id')),
        kind: itemKind(row.kind),
        title: string(row.title),
        taskRefs: stringArray(valueAt(row, 'taskRefs', 'task_refs')),
        dependencyRefs: stringArray(valueAt(row, 'dependencyRefs', 'dependency_refs')),
        ...(startsAt ? { startsAt } : {}),
        ...(endsAt ? { endsAt } : {}),
        ...(placeRef ? { placeRef } : {}),
        ...(reservationRef ? { reservationRef } : {}),
        ...(journalNoteRef ? { journalNoteRef } : {}),
      };
    }).filter((item) => item.id),
  };
}

export function itemsForTripDay(itinerary: Itinerary, tripDayId: string): ItineraryItem[] {
  return itinerary.items
    .filter((item) => item.tripDayId === tripDayId)
    .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
}

export function daysForTrip(itinerary: Itinerary, tripId: string): TripDay[] {
  return itinerary.days
    .filter((day) => day.tripId === tripId)
    .sort((a, b) => a.sequence - b.sequence);
}

function itineraryTransition(item: ItineraryItem) {
  return {
    id: `transition:itinerary:update:${item.id}`,
    ownerPackage: 'itinerary',
    actionDefinitionId: 'action:itinerary:update',
    label: 'Update itinerary item',
    input: { itemId: item.id, tripDayId: item.tripDayId },
    modeHints: ['next' as const],
  };
}

export function buildItineraryOperations(itinerary: Itinerary, tripId = itinerary.trips[0]?.id ?? ''): OperationRecord[] {
  const days = daysForTrip(itinerary, tripId);
  const dayById = new Map(days.map((day) => [day.id, day]));
  const dayOperations = days.map<OperationRecord>((day) => ({
    id: `operation:itinerary:day:${day.id}`,
    ownerPackage: 'itinerary',
    source: { package: 'itinerary', type: 'trip_day', id: day.id },
    kindDescriptor: 'itinerary.kind.trip-day',
    stateDescriptor: 'itinerary.state.scheduled',
    priority: 'low',
    priorityDescriptor: 'operation.priority.low',
    timeWindow: { localDate: day.localDate },
    linkRefs: [day.tripId],
    dependencyRefs: [],
    evidenceRefs: [],
    candidateFactRefs: [],
    transitions: [],
    display: {
      title: day.title || `Trip day ${day.sequence}`,
      status: day.localDate,
      reason: 'Scheduled trip day',
      detail: [`${itemsForTripDay(itinerary, day.id).length} itinerary items`],
    },
    privacyClass: 'personal',
    modeHints: ['timeline'],
    sortKey: `${day.sequence.toString().padStart(4, '0')}:${day.id}`,
  }));
  const itemOperations = itinerary.items
    .filter((item) => dayById.has(item.tripDayId))
    .map<OperationRecord>((item) => {
      const day = dayById.get(item.tripDayId);
      const linkRefs = [item.tripDayId, item.placeRef, item.reservationRef, item.journalNoteRef, ...item.taskRefs].filter((entry): entry is string => Boolean(entry));
      const priority = item.reservationRef ? 'normal' : 'low';
      return {
        id: `operation:itinerary:item:${item.id}`,
        ownerPackage: 'itinerary',
        source: { package: 'itinerary', type: 'itinerary_item', id: item.id },
        kindDescriptor: `itinerary.kind.${item.kind || 'custom'}`,
        stateDescriptor: 'itinerary.state.scheduled',
        priority,
        priorityDescriptor: `operation.priority.${priority}`,
        timeWindow: { ...(item.startsAt ? { startsAt: item.startsAt } : {}), ...(item.endsAt ? { endsAt: item.endsAt } : {}), ...(day?.localDate ? { localDate: day.localDate } : {}) },
        linkRefs,
        dependencyRefs: item.dependencyRefs,
        evidenceRefs: item.reservationRef ? [item.reservationRef] : [],
        candidateFactRefs: [],
        transitions: [itineraryTransition(item)],
        display: {
          title: item.title || item.id,
          status: item.startsAt ? `Starts ${item.startsAt}` : 'Scheduled',
          reason: item.reservationRef ? 'Linked reservation drives readiness' : 'Trip schedule item',
          detail: linkRefs,
        },
        privacyClass: 'personal',
        modeHints: ['next', 'timeline', ...(item.reservationRef ? ['review' as const] : [])],
        sortKey: `${day?.sequence.toString().padStart(4, '0') ?? '9999'}:${item.startsAt ?? '99:99'}:${item.id}`,
      };
    });
  return [...dayOperations, ...itemOperations];
}

export function decodeItineraryOperationFeed(raw: unknown, tripId?: string): OperationRecord[] {
  const itinerary = decodeItinerary(raw);
  return buildItineraryOperations(itinerary, tripId ?? itinerary.trips[0]?.id ?? '');
}
