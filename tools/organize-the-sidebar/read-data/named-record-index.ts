// packages/group/read-data/named-record-index.ts
//
// The GENERIC named-record store — the primitive under every "saved library of named things" on a board. A
// saved collection (a BoardTemplate), a saved report (a ReportDescriptor), a saved filter, a saved lens are
// the SAME shape: a named, archivable record kept as a member of an index group, keyed by a record id, with an
// opaque payload the owner knows how to parse. So this owns the CRUD once; each record TYPE is a thin
// `RecordStoreSpec` config (its index/node families, its `kind` tag, and its payload parser) — collection-store
// and saved-report-store are both ~30-line configs over this, not two copies of the same fold logic (L069/
// L100). No I/O, no React, no Date/random — the caller supplies `savedAt`. Fail-closed: a member whose payload
// fails the spec's parser is skipped, so a malformed record never surfaces.

import {
  addMember,
  ensureGroup,
  getGroup,
  membersOf,
  setMemberFields,
  type AddressRef,
  type GroupGraph,
} from '../../ui/show/group/group-graph';

/** How to store one record TYPE: where its index/nodes live, its presentation `kind` tag, how to parse its
 *  payload, and how to derive an id/name from a payload when the member's own fields are missing. */
export interface RecordStoreSpec<T> {
  readonly indexFamily: string;
  readonly nodeFamily: string;
  /** The `parts` key of a record's node ref (e.g. `collection`, `report`). */
  readonly partKey: string;
  /** The `presentation.kind` tag written for this record type. */
  readonly kind: string;
  /** Strictly validate an unknown stored payload; null on any violation (never throws). */
  readonly parseRecord: (value: unknown) => T | null;
  /** A record's own id, used only when a member lacks a stored `recordId`. */
  readonly idOf: (record: T) => string;
  /** A record's own name, used only when a member lacks a stored `name`. */
  readonly nameOf: (record: T) => string;
}

/** One stored record decoded from an index member. `record` is the parsed payload; `recordId`/`name` fall back
 *  to the payload's own id/name (via the spec) when the member didn't store them. */
export interface StoredRecord<T> {
  readonly memberId: string;
  readonly recordId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly record: T;
  readonly savedAt?: number;
}

/** The index ref for a surface — an index group whose members each carry one saved record of this type. Keyed
 *  by the surface id, using the spec's own family so different record types never collide for the same id. */
export function recordIndexRef<T>(spec: RecordStoreSpec<T>, indexId = 'vision-board'): AddressRef {
  return { family: spec.indexFamily, parts: { index: indexId } };
}

function nodeRef<T>(spec: RecordStoreSpec<T>, recordId: string): AddressRef {
  return { family: spec.nodeFamily, parts: { [spec.partKey]: recordId } };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Every record registered in an index, in order (active + archived). A member whose payload fails the spec's
 *  parser is skipped, so the store never surfaces a malformed record. */
export function readRecords<T>(graph: GroupGraph, indexRef: AddressRef, spec: RecordStoreSpec<T>): StoredRecord<T>[] {
  const out: StoredRecord<T>[] = [];
  for (const member of membersOf(graph, indexRef)) {
    const p = (member.presentation ?? {}) as Record<string, unknown>;
    const record = spec.parseRecord(p.record);
    if (record === null) continue;
    out.push({
      memberId: member.memberId,
      recordId: typeof p.recordId === 'string' ? p.recordId : spec.idOf(record),
      name: typeof p.name === 'string' && p.name ? p.name : spec.nameOf(record),
      archived: p.archived === true,
      record,
      savedAt: typeof p.savedAt === 'number' && Number.isFinite(p.savedAt) ? p.savedAt : undefined,
    });
  }
  return out;
}

export function readActiveRecords<T>(graph: GroupGraph, indexRef: AddressRef, spec: RecordStoreSpec<T>): StoredRecord<T>[] {
  return readRecords(graph, indexRef, spec).filter((r) => !r.archived);
}

/** Rejected records stay addressable for explanation and recovery, never execution.
 * Do not return their malformed contents as a usable record or invent defaults. */
export interface RejectedStoredRecord {
  readonly memberId: string;
  readonly name: string;
  readonly archived: boolean;
}

export function readRejectedRecords<T>(graph: GroupGraph, indexRef: AddressRef, spec: RecordStoreSpec<T>): RejectedStoredRecord[] {
  return membersOf(graph, indexRef).flatMap(member => {
    const p = (member.presentation ?? {}) as Record<string, unknown>;
    if (spec.parseRecord(p.record) !== null) return [];
    return [{ memberId: member.memberId, name: typeof p.name === 'string' ? p.name : '', archived: p.archived === true }];
  });
}

export function readArchivedRecords<T>(graph: GroupGraph, indexRef: AddressRef, spec: RecordStoreSpec<T>): StoredRecord<T>[] {
  return readRecords(graph, indexRef, spec).filter((r) => r.archived);
}

export function getRecord<T>(graph: GroupGraph, indexRef: AddressRef, memberId: string, spec: RecordStoreSpec<T>): StoredRecord<T> | undefined {
  return readRecords(graph, indexRef, spec).find((r) => r.memberId === memberId);
}

/** Save a record into the index (add-or-update, keyed by memberId). A re-save of an existing memberId updates
 *  its fields in place and PRESERVES its archived flag (a re-save never un-archives). Immutable fold. */
export function saveRecord<T>(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; recordId: string; name: string; record: T; savedAt?: number },
  spec: RecordStoreSpec<T>,
): GroupGraph {
  const presentation = pruneUndefined({
    kind: spec.kind,
    recordId: args.recordId,
    name: args.name,
    record: args.record,
    savedAt: args.savedAt,
  });
  const withIndex = ensureGroup(graph, indexRef);
  const existing = getGroup(withIndex, indexRef)?.members[args.memberId];
  if (existing) {
    const prev = (existing.presentation ?? {}) as Record<string, unknown>;
    return setMemberFields(withIndex, indexRef, args.memberId, {
      presentation: pruneUndefined({ ...presentation, archived: prev.archived === true ? true : undefined }),
    });
  }
  return addMember(withIndex, indexRef, nodeRef(spec, args.recordId), { memberId: args.memberId, presentation });
}

/** Rename a saved record (the label shown in the library); leaves its payload untouched. */
export function renameRecord(graph: GroupGraph, indexRef: AddressRef, memberId: string, name: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, name } });
}

/** Archive a record (recoverable soft-delete). Already-archived → the same graph ref (immutability). */
export function archiveRecord(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  if (current.archived === true) return graph;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, archived: true } });
}

/** Restore an archived record back into the active library. Already-active → the same graph ref. */
export function restoreRecord(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  const current = (getGroup(graph, indexRef)?.members[memberId]?.presentation ?? {}) as Record<string, unknown>;
  if (current.archived !== true) return graph;
  return setMemberFields(graph, indexRef, memberId, { presentation: { ...current, archived: false } });
}
