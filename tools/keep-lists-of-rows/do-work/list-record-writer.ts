// parts/visual-database/do-work/list-record-writer.ts
//
// PURPOSE
//   The write half of the records seam for a Trillion list that keeps changes (read-data/visual-database-input-from-
//   list.ts is the read half). `listKeeper` gives the surface its one record writer (a title typed, a status set, a
//   record added under another, a record deleted, each kept as the list's own changes in one call, with an independent
//   read of the list itself for the surface's settlement) and `place`, which keeps a record moved in the nesting: out
//   of every record it sat under and into its new place, before a sibling or last.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The list owns its records: nothing is kept here; each change is worked out against the list read again, one at a
//      time, and settled against the list read again.
//   2. Nesting has one model: where a record sits is the ordered members of the record it sits under (the list's group
//      graph), so adding under, moving and deleting are `members` changes to each record a record leaves or joins.
//   3. A new record keeps the address the surface gave it, so the surface finds the record it made.
//   4. Only values that changed are sent, and only for fields the list lets be typed into. No field or list is named.

import { blake3 } from '@noble/hashes/blake3.js';
import type { AddressedCurrentSnapshot, AddressedWrite, RecordWriter } from './record-writes';
import { NESTED_UNDER, listRecordPayloads, nestingFromGroupGraph, type ListContext, type ListRecordChange } from '../read-data/visual-database-input-from-list';

const parentsOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const withoutOf = (members: readonly string[], ids: ReadonlySet<string>) => members.filter(id => !ids.has(id));

/** Who sits under each record now, in order. */
const membersNow = (context: ListContext) => (context.nesting ? nestingFromGroupGraph(context.nesting).children : new Map<string, string[]>());

/** The changes a batch of the surface's writes asks the list to keep, worked out against the list as it was read. */
export function listChangesFromWrites(context: ListContext, writes: readonly AddressedWrite[]): ListRecordChange[] {
  const current = new Map(listRecordPayloads(context).map(({ id, payload }) => [id, payload]));
  const typed = context.fields.filter(field => field.editable !== false).map(field => field.id);
  const members = new Map(membersNow(context));
  const changes = new Map<string, ListRecordChange>();
  const changeOf = (id: string) => changes.get(id) ?? changes.set(id, { id }).get(id)!;
  const setMembers = (parent: string, next: string[]) => { members.set(parent, next); changeOf(parent).members = next; };
  const removed = new Set<string>();

  for (const write of writes) {
    const id = write.addressLabel;
    const before = current.get(id);
    if (write.payload === null) {
      if (!before) continue;
      removed.add(id);
      for (const parent of parentsOf(before[NESTED_UNDER])) setMembers(parent, withoutOf(members.get(parent) ?? [], new Set([id])));
      continue;
    }
    const payload = (write.payload ?? {}) as Record<string, unknown>;
    const values: Record<string, unknown> = {};
    for (const field of typed) {
      if (!(field in payload)) continue;
      const value = payload[field];
      if (before ? !same(value, before[field]) : value !== null && value !== undefined && value !== '') values[field] = value ?? null;
    }
    if (!before || Object.keys(values).length > 0) {
      const change = changeOf(id);
      if (!before) change.create = true;
      change.values = { ...change.values, ...values };
    }
    if (context.nesting && NESTED_UNDER in payload) {
      const was = before ? parentsOf(before[NESTED_UNDER]) : [];
      const now = parentsOf(payload[NESTED_UNDER]);
      for (const parent of was.filter(parent => !now.includes(parent))) setMembers(parent, withoutOf(members.get(parent) ?? [], new Set([id])));
      for (const parent of now.filter(parent => !was.includes(parent))) setMembers(parent, [...withoutOf(members.get(parent) ?? [], new Set([id])), id]);
    }
  }
  return [...[...changes.values()].filter(change => !removed.has(change.id)), ...[...removed].map(id => ({ id, remove: true }))];
}

/** A record moved in the nesting: under `under` (or under none), before the sibling `before` (or last). */
export interface ListPlacement {
  record: string;
  under: string | null;
  before: string | null;
}

/** The changes that move a record: out of every record it sat under, into its place under the new one. A move into
 * itself or into a record under it is refused, since a record can never sit inside itself. */
export function listPlacementChanges(context: ListContext, move: ListPlacement): ListRecordChange[] {
  const members = membersNow(context);
  const under = new Set<string>();
  const walk = (id: string) => { for (const child of members.get(id) ?? []) if (!under.has(child)) { under.add(child); walk(child); } };
  walk(move.record);
  if (move.under !== null && (move.under === move.record || under.has(move.under))) {
    throw new Error('A task cannot go inside itself or inside one of its own sub-tasks.');
  }
  const changes = new Map<string, ListRecordChange>();
  const moving = new Set([move.record]);
  for (const [parent, held] of members) {
    if (held.includes(move.record) && parent !== move.under) changes.set(parent, { id: parent, members: withoutOf(held, moving) });
  }
  if (move.under !== null) {
    const siblings = withoutOf(members.get(move.under) ?? [], moving);
    const at = move.before === null ? -1 : siblings.indexOf(move.before);
    changes.set(move.under, { id: move.under, members: at < 0 ? [...siblings, move.record] : [...siblings.slice(0, at), move.record, ...siblings.slice(at)] });
  }
  return [...changes.values()];
}

/** The surface's record writer over a list (as `current` reads it now), and its nesting move. Changes are kept one
 * batch at a time, each worked out against the list read again just before it (so two quick changes to the same
 * task's sub-tasks never undo one another), and `readCurrent` reads the list again, so the surface settles a change
 * only once the list holds it. */
export function listKeeper(current: () => ListContext): {
  writeRecord: RecordWriter;
  place: (move: ListPlacement) => Promise<void>;
} {
  const latest = async (): Promise<ListContext> => {
    const context = current();
    return context.reread ? { ...context, ...(await context.reread()) } : context;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = (keep: (list: ListContext) => ListRecordChange[]) => {
    const turn = queue.then(async () => {
      const list = await latest();
      const changes = keep(list);
      if (!list.write) throw new Error('This list does not keep changes.');
      if (changes.length > 0) await list.write(changes);
    });
    queue = turn.catch(() => undefined);
    return turn;
  };
  const writeRecord = ((write: AddressedWrite) => inTurn(list => listChangesFromWrites(list, [write]))) as RecordWriter;
  writeRecord.batch = (writes) => inTurn(list => listChangesFromWrites(list, writes));
  // Every record of one batch is checked against the same read of the list.
  let reading: Promise<ListContext> | null = null;
  Object.defineProperty(writeRecord, 'readCurrent', {
    enumerable: true,
    value: async (addressLabel: string): Promise<AddressedCurrentSnapshot | null> => {
      reading ??= latest().finally(() => { reading = null; });
      const found = listRecordPayloads(await reading).find(({ id }) => id === addressLabel);
      return found ? { payload: found.payload, payloadHash: blake3(new TextEncoder().encode(JSON.stringify(found.payload))) } : null;
    },
  });
  return { writeRecord, place: move => inTurn(list => listPlacementChanges(list, move)) };
}
