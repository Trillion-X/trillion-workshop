// package-set://bitfield-studio/packages/marketing-pipeline/read-data/coordination-metrics.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure derivations OVER the decoded CoordinationSurfaceModel — the grouping and
// inbox structure the workbench needs for scanning, computed from REAL record
// data only (never fabricated). Two derivations live here:
//
//   1. groupRecords()  — partition records by the values of a grouping field,
//                        preserving first-seen order. This is the SINGLE grouping
//                        pass: the rendered groups AND the scan-row counts both
//                        derive from it (count = group.records.length), so there
//                        is no parallel tally to drift (N+1 SSOT trap avoided).
//   2. inboxEntries()  — the distinct upstream connections (relationships) each
//                        record carries, linked back to their record so the
//                        source-inbox rail can navigate to real work.
//
// Both are pure functions of the model. They invent nothing: an empty model
// yields empty results (L117 — no fake rows, no placeholder metrics).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE: no React, no DOM, no humanize, no statusView — these are data
//    transforms. Grouping yields RAW keys; the show layer resolves each key to
//    its human label (choice → statusView label) at render (L098 translation
//    stays in show). Counts are length, never a second tally.
// 2. REAL DATA ONLY: every group holds actual records; every inbox entry is an
//    actual relationship on an actual record. Nothing is synthesized.
// 3. GENERIC: no marketing/booking/crm vocabulary — works for ANY coordination
//    model. The grouping field is supplied by the caller.
//
// =============================================================================

import type {
  CoordinationRecord,
  CoordinationSurfaceModel,
} from './read-coordination-records';

/** Empty grouping-key sentinel — records with no value for the field land here. */
export const UNSORTED_GROUP_KEY = '__unsorted__';

/** One partition of records by a grouping field's value (RAW key + members). */
export interface CoordinationRecordGroup {
  /** Raw field value the group is keyed by, or UNSORTED_GROUP_KEY when absent. */
  key: string;
  /** The records that fall in this group, in their incoming order. */
  records: CoordinationRecord[];
}

/** Generic scalar → group key (mirrors field-value-view's valueToText). */
function scalarKey(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '' : `${value.length}`;
  return '';
}

/**
 * Partition records by the values of one field, preserving first-seen order so
 * the groups read in the order their values first appear. With no grouping field
 * every record lands in ONE group keyed UNSORTED_GROUP_KEY (the caller renders it
 * without a header). Empty field values collapse into a single UNSORTED bucket.
 * The scan-row counts are `group.records.length` — there is no separate tally.
 */
export function groupRecords(
  records: CoordinationRecord[],
  fieldId: string | undefined,
): CoordinationRecordGroup[] {
  if (!fieldId) return records.length === 0 ? [] : [{ key: UNSORTED_GROUP_KEY, records }];

  const order: string[] = [];
  const byKey = new Map<string, CoordinationRecord[]>();
  for (const record of records) {
    const key = scalarKey(record.fieldValues[fieldId]) || UNSORTED_GROUP_KEY;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(record);
  }
  return order.map((key) => ({ key, records: byKey.get(key)! }));
}

/** A real upstream connection on a record, kept linked to that record for nav. */
export interface CoordinationInboxEntry {
  /** Stable identity for the entry (role + target). */
  id: string;
  /** Relationship role as authored (raw — the show layer humanizes it). */
  role: string;
  /** The connected ref (raw). */
  targetRef: string;
  /** The owning namespace of the ref, when present (raw). */
  ownerRef?: string;
  /** The record this connection belongs to — selecting the entry opens it. */
  recordId: string;
}

/**
 * The distinct connections across all records, each linked back to the FIRST
 * record that carries it (so the inbox rail can select real work when an entry
 * is chosen). Deduplicated by role+target so the rail does not repeat the same
 * upstream source once per record. Empty model → empty inbox (the rail hides).
 */
export function inboxEntries(model: CoordinationSurfaceModel): CoordinationInboxEntry[] {
  const seen = new Set<string>();
  const entries: CoordinationInboxEntry[] = [];
  for (const record of model.records) {
    for (const relationship of record.relationships) {
      if (!relationship.targetRef) continue;
      const id = `${relationship.role}:${relationship.targetRef}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        role: relationship.role,
        targetRef: relationship.targetRef,
        ownerRef: relationship.ownerRef,
        recordId: record.id,
      });
    }
  }
  return entries;
}
