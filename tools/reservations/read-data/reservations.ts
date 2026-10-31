// A reservation is anything held for a person at a time: a table, a room, a seat, a visit.
// This reads rows in either spelling (camelCase or snake_case), keeps the ones that have an id,
// and groups them by status. Which statuses a person uses, and which need attention first, are
// the person's own words: nothing here lists them.

export interface Reservation {
  id: string;
  kind: string;
  title: string;
  status: string;
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function valueAt(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function optionalText(row: Record<string, unknown>, camel: string, snake: string): string | undefined {
  return text(valueAt(row, camel, snake)) || undefined;
}

/** Reservations from a list, or from `{ reservations: [...] }`. A row with no id is dropped. */
export function decodeReservations(raw: unknown): Reservation[] {
  const source = Array.isArray(raw) ? raw : (Array.isArray(object(raw).reservations) ? object(raw).reservations as unknown[] : []);
  return source.map((entry) => {
    const row = object(entry);
    const startsAt = optionalText(row, 'startsAt', 'starts_at');
    const endsAt = optionalText(row, 'endsAt', 'ends_at');
    const providerRef = optionalText(row, 'providerRef', 'provider_ref');
    const confirmationCode = optionalText(row, 'confirmationCode', 'confirmation_code');
    const itineraryItemRef = optionalText(row, 'itineraryItemRef', 'itinerary_item_ref');
    const journalNoteRef = optionalText(row, 'journalNoteRef', 'journal_note_ref');
    const policyRef = optionalText(row, 'policyRef', 'policy_ref');
    const cost = object(row.cost);
    const deposit = object(row.deposit);
    return {
      id: text(row.id),
      kind: text(row.kind) || 'custom',
      title: text(row.title),
      status: text(row.status) || 'idea',
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
