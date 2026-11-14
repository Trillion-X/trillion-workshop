
import type { OperationRecord } from '@/packages/operation-records/read-data/operation-records';

export type ReservationStatus = string;
export type ReservationKind = string;

export interface Reservation {
  id: string;
  kind: ReservationKind;
  title: string;
  status: ReservationStatus;
  startsAt?: string;
  endsAt?: string;
  providerRef?: string;
  confirmationCode?: string;
  itineraryItemRef?: string;
  taskRefs: string[];
  journalNoteRef?: string;
  partyRefs: string[];
  policyRef?: string;
  cost?: Record<string, unknown>;
  deposit?: Record<string, unknown>;
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

function valueAt(row: Record<string, unknown>, camel: string, snake = camel): unknown {
  return row[camel] ?? row[snake];
}

function optionalString(row: Record<string, unknown>, camel: string, snake = camel): string | undefined {
  const value = string(valueAt(row, camel, snake));
  return value || undefined;
}

function reservationStatus(value: unknown): ReservationStatus {
  return string(value) || 'idea';
}

function reservationKind(value: unknown): ReservationKind {
  return string(value) || 'custom';
}

export function decodeReservations(raw: unknown): Reservation[] {
  const source = Array.isArray(raw) ? raw : array(object(raw).reservations);
  return source.map((entry) => {
    const row = object(entry);
    const startsAt = optionalString(row, 'startsAt', 'starts_at');
    const endsAt = optionalString(row, 'endsAt', 'ends_at');
    const providerRef = optionalString(row, 'providerRef', 'provider_ref');
    const confirmationCode = optionalString(row, 'confirmationCode', 'confirmation_code');
    const itineraryItemRef = optionalString(row, 'itineraryItemRef', 'itinerary_item_ref');
    const journalNoteRef = optionalString(row, 'journalNoteRef', 'journal_note_ref');
    const policyRef = optionalString(row, 'policyRef', 'policy_ref');
    const cost = object(row.cost);
    const deposit = object(row.deposit);
    return {
      id: string(row.id),
      kind: reservationKind(row.kind),
      title: string(row.title),
      status: reservationStatus(row.status),
      taskRefs: stringArray(valueAt(row, 'taskRefs', 'task_refs')),
      partyRefs: stringArray(valueAt(row, 'partyRefs', 'party_refs')),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
      ...(providerRef ? { providerRef } : {}),
      ...(confirmationCode ? { confirmationCode } : {}),
      ...(itineraryItemRef ? { itineraryItemRef } : {}),
      ...(journalNoteRef ? { journalNoteRef } : {}),
      ...(policyRef ? { policyRef } : {}),
      ...(Object.keys(cost).length ? { cost } : {}),
      ...(Object.keys(deposit).length ? { deposit } : {}),
    };
  }).filter((reservation) => reservation.id);
}

export function reservationsByStatus(reservations: readonly Reservation[]): Record<string, Reservation[]> {
  const groups: Record<string, Reservation[]> = {};
  for (const reservation of reservations) groups[reservation.status] = [...(groups[reservation.status] ?? []), reservation];
  return groups;
}

function reservationPriority(status: string): OperationRecord['priority'] {
  if (status === 'changed' || status === 'cancelled') return 'critical';
  if (status === 'requested' || status === 'held') return 'high';
  if (status === 'completed') return 'done';
  return 'normal';
}

function statusLabel(status: string): string {
  return status.replace(/[-_]/g, ' ');
}

export function buildReservationOperations(reservations: readonly Reservation[]): OperationRecord[] {
  return reservations.map<OperationRecord>((reservation) => {
    const priority = reservationPriority(reservation.status);
    const linkRefs = [reservation.providerRef, reservation.itineraryItemRef, reservation.journalNoteRef, reservation.policyRef, ...reservation.taskRefs, ...reservation.partyRefs].filter((entry): entry is string => Boolean(entry));
    const sensitiveRefs = reservation.confirmationCode ? [`confirmation:${reservation.id}`] : [];
    return {
      id: `operation:reservation-tracker:reservation:${reservation.id}`,
      ownerPackage: 'reservation-tracker',
      source: { package: 'reservation-tracker', type: 'reservation', id: reservation.id },
      kindDescriptor: `reservation-tracker.kind.${reservation.kind}`,
      stateDescriptor: `reservation-tracker.state.${reservation.status}`,
      priority,
      priorityDescriptor: `operation.priority.${priority}`,
      timeWindow: { ...(reservation.startsAt ? { startsAt: reservation.startsAt } : {}), ...(reservation.endsAt ? { endsAt: reservation.endsAt } : {}) },
      linkRefs,
      dependencyRefs: reservation.policyRef ? [] : [`policy:${reservation.id}`],
      evidenceRefs: sensitiveRefs,
      candidateFactRefs: reservation.status === 'changed' ? [`candidate:${reservation.id}:change-review`] : [],
      transitions: reservation.status === 'confirmed' ? [] : [{
        id: `transition:reservation-tracker:confirm:${reservation.id}`,
        ownerPackage: 'reservation-tracker',
        actionDefinitionId: 'action:reservation-tracker:update-status',
        label: 'Mark confirmed',
        input: { reservationId: reservation.id, status: 'confirmed' },
        targetStateDescriptor: 'reservation-tracker.state.confirmed',
        modeHints: ['now', 'review'],
      }],
      display: {
        title: reservation.title || reservation.id,
        status: statusLabel(reservation.status),
        reason: reservation.status === 'changed' ? 'Reservation changed and needs review' : reservation.status === 'held' || reservation.status === 'requested' ? 'Reservation is not confirmed' : 'Reservation tracked',
        detail: [reservation.kind, reservation.providerRef, reservation.itineraryItemRef, reservation.policyRef].filter((entry): entry is string => Boolean(entry)),
      },
      privacyClass: reservation.confirmationCode ? 'sensitive' : 'personal',
      modeHints: ['timeline', ...(priority === 'high' || priority === 'critical' ? ['now' as const, 'risks' as const, 'review' as const] : ['next' as const])],
      sortKey: `${priority === 'critical' ? '0' : priority === 'high' ? '1' : '3'}:${reservation.startsAt ?? ''}:${reservation.id}`,
    };
  });
}

export function decodeReservationOperationFeed(raw: unknown): OperationRecord[] {
  return buildReservationOperations(decodeReservations(raw));
}
