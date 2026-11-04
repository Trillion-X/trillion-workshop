// packages/group/read-data/group-eeaf.ts
//
// PURPOSE
// The EEAF translation boundary (L098) for the Universal Addressed Group. The
// `group` package STORES one record per group; CALLERS get a finished
// `GroupGraph`. This module is the only place that knows the record shape — it
// folds raw group records INTO a GroupGraph (read path) and diffs two
// GroupGraphs INTO an EEAF write-set (write path). The pure membership logic
// itself lives in the shared leaf `ui/show/group/group-graph`; this module owns
// ONLY the storage⇄graph translation, never the membership rules.
//
// NON-NEGOTIABLE INVARIANTS
//   - SSOT: the leaf is the canonical membership logic. This codec never
//     re-implements add/move/cycle — it only (de)serializes Groups.
//   - BLIND: a group record's value is the leaf `Group` verbatim; this codec
//     never enumerates member family or interprets role/presentation.
//   - DETERMINISTIC: fold sorts group keys so the assembled graph and any
//     re-serialization are stable (machine-readable, reproducible).
//
// RECORD SHAPE
//   address    `package::group::group::<groupKey>`  (groupKey = serializeNodeRef(groupRef))
//   value_json  a leaf `Group` ({ groupRef, memberOrder, members }) — object or JSON string.

import {
  groupKey,
  isGroupGraph,
  type Group,
  type GroupGraph,
} from '../../ui/show/group/group-graph.ts';
import type { AddressRef } from '../../ui/show/visual-layer-stack/visual-layer-types';

/** One persisted group, as it sits in the log (value may arrive parsed or as JSON text). */
export interface GroupRecord {
  readonly address: string;
  readonly value_json: unknown;
}

/** A write-batch entry this codec emits for the live writer. */
export interface GroupWrite {
  readonly address: string;
  readonly value_json: Group;
}

/** The persisted record payload: the leaf Group plus an optional tombstone marker. */
export type GroupRecordPayload = Group & { readonly status?: 'deleted' };

/** The address a group record lives at. The single source of the storage key. */
export function groupRecordAddress(groupRef: AddressRef): string {
  return `package::group::group::${groupKey(groupRef)}`;
}

type ParsedRecord =
  | { readonly kind: 'group'; readonly key: string; readonly group: Group }
  | { readonly kind: 'tombstone'; readonly key: string }
  | null;

/**
 * Parse one raw record into a live group, a tombstone (carries its key so the
 * fold can REMOVE that group — latest-wins includes deletes), or null (malformed).
 *
 * INTEGRITY: the record's STORED address is the authoritative identity (a legit write always
 * lands at `groupRecordAddress(groupRef)` — read+write addressing are one SSOT choice). A record
 * whose payload declares a groupRef that maps to a DIFFERENT address than where it is stored is a
 * cross-address SPOOF — folded blindly it could clobber or tombstone an UNRELATED group (e.g. a
 * record living at a child's address but declaring the root groupRef + status:'deleted' would
 * delete the root). Reject the mismatch (fail closed): key ONLY by an address-consistent groupRef.
 */
function parseRecord(record: GroupRecord): ParsedRecord {
  const value = record.value_json;
  const obj = typeof value === 'string' ? safeJson(value) : value;
  if (!obj || typeof obj !== 'object') return null;
  const isGroupShaped = isGroupGraph({ groups: { x: obj } });
  if (!isGroupShaped) return null;
  const group = obj as Group;
  if (groupRecordAddress(group.groupRef) !== record.address) return null; // cross-address spoof → drop
  const key = groupKey(group.groupRef);
  if ((obj as { status?: unknown }).status === 'deleted') return { kind: 'tombstone', key };
  return { kind: 'group', key, group };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * READ PATH — fold raw group records into a GroupGraph.
 * Malformed records are skipped (blind tolerance); a later record at the same
 * address wins (latest-write-wins is the caller's ordering responsibility — pass
 * records already in log order).
 */
export function foldGroupRecords(records: readonly GroupRecord[]): GroupGraph {
  const groups: Record<string, Group> = {};
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue; // a null/malformed envelope entry → skip, never crash
    const parsed = parseRecord(rec);
    if (!parsed) continue;
    if (parsed.kind === 'tombstone') delete groups[parsed.key]; // later delete wins
    else groups[parsed.key] = parsed.group;
  }
  // Deterministic assembly: sorted keys.
  const sorted: Record<string, Group> = {};
  for (const key of Object.keys(groups).sort()) sorted[key] = groups[key];
  return { groups: sorted };
}

/**
 * WRITE PATH — diff two GroupGraphs into the minimal EEAF write-set.
 * Returns `upserts` (groups that are new or changed) and `deletes` (addresses of
 * groups that vanished — e.g. an ungroup dissolved a sub-group). A do-work
 * mutation target runs `before → leaf-op → after`, then hands this write-set to
 * the live writer. Unchanged groups (shared by reference from the leaf's
 * structural sharing) produce ZERO writes — O(changed), never O(all).
 */
export function groupGraphWriteSet(
  before: GroupGraph,
  after: GroupGraph,
): { readonly upserts: readonly GroupWrite[]; readonly tombstones: readonly GroupWrite[] } {
  const upserts: GroupWrite[] = [];
  const tombstones: GroupWrite[] = [];

  for (const [key, group] of Object.entries(after.groups)) {
    const prev = before.groups[key];
    if (prev === group) continue; // structural-sharing fast path: identical reference → unchanged
    if (prev && shallowGroupEqual(prev, group)) continue; // value-equal → no write
    upserts.push({ address: groupRecordAddress(group.groupRef), value_json: group });
  }
  for (const [key, group] of Object.entries(before.groups)) {
    // A group that vanished is tombstoned: re-write the prior record with
    // status:'deleted' (the codebase-canonical honest delete — the fold drops it).
    if (!(key in after.groups)) {
      tombstones.push({ address: groupRecordAddress(group.groupRef), value_json: group });
    }
  }
  return { upserts, tombstones };
}

/** True iff two Groups hold the same order and the same members (by value). */
function shallowGroupEqual(a: Group, b: Group): boolean {
  if (a.memberOrder.length !== b.memberOrder.length) return false;
  for (let i = 0; i < a.memberOrder.length; i++) if (a.memberOrder[i] !== b.memberOrder[i]) return false;
  const ak = Object.keys(a.members);
  const bk = Object.keys(b.members);
  if (ak.length !== bk.length) return false;
  // Members are immutable in the leaf (replaced, not mutated) — compare by JSON.
  return JSON.stringify(a.members) === JSON.stringify(b.members);
}
