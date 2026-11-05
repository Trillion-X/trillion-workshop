// packages/group/read-data/saved-report-store.ts
//
// The persistence store for saved REPORTS — a named, re-openable board report is a `ReportDescriptor` (b179)
// kept in the library beside saved collections. This is the SECOND consumer of the generic named-record-index
// (b181): it is a ~30-line SPEC + thin wrappers, NOT a second copy of the save/list/archive fold — the whole
// point of extracting the generic store. A saved report re-runs against the live board via `runReport(items,
// stored.descriptor)`, so the same named analysis reflects the board as it changes. Fail-closed: a stored
// descriptor with a non-string field is rejected by `parseReportDescriptor`, so a malformed report never
// surfaces. No I/O, no React, no Date/random — the caller supplies `savedAt`.

import { type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import { type ReportDescriptor } from './board-report.ts';
import {
  recordIndexRef,
  readRecords,
  readActiveRecords,
  readArchivedRecords,
  getRecord,
  saveRecord,
  renameRecord,
  archiveRecord,
  restoreRecord,
  type RecordStoreSpec,
  type StoredRecord,
} from './named-record-index.ts';

const OPTIONAL_STRING_FIELDS = ['dimension', 'colDimension', 'measure', 'aggregator', 'title'] as const;

/** Strictly validate an unknown value as a ReportDescriptor; null on any violation (never throws). `reduction`
 *  is a required string; every other field is a string when present. Unknown extra keys are dropped. */
export function parseReportDescriptor(value: unknown): ReportDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.reduction !== 'string') return null;
  for (const k of OPTIONAL_STRING_FIELDS) if (o[k] !== undefined && typeof o[k] !== 'string') return null;
  const out: { reduction: string; dimension?: string; colDimension?: string; measure?: string; aggregator?: string; title?: string } = { reduction: o.reduction };
  for (const k of OPTIONAL_STRING_FIELDS) if (typeof o[k] === 'string') out[k] = o[k] as string;
  return out;
}

// The report record TYPE as a named-record-index config — its own index/node family so it never collides with
// collections or boards. A descriptor has no intrinsic id, so `idOf` falls back to its reduction and `nameOf`
// to its title (both only used when a member somehow lacks its stored id/name — save always supplies them).
const REPORT_SPEC: RecordStoreSpec<ReportDescriptor> = {
  indexFamily: 'group.report-index',
  nodeFamily: 'group.report',
  partKey: 'report',
  kind: 'report',
  parseRecord: parseReportDescriptor,
  idOf: (d) => d.reduction,
  nameOf: (d) => d.title ?? d.reduction,
};

/** One saved report decoded from an index member — the descriptor plus its library metadata. */
export interface StoredReport {
  readonly memberId: string;
  readonly reportId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly descriptor: ReportDescriptor;
  readonly savedAt?: number;
}

function toReport(r: StoredRecord<ReportDescriptor>): StoredReport {
  return { memberId: r.memberId, reportId: r.recordId, name: r.name, archived: r.archived, descriptor: r.record, ...(r.savedAt !== undefined ? { savedAt: r.savedAt } : {}) };
}

/** The report-index ref for a surface (default vision-board). Distinct family from collections/boards. */
export function reportIndexRef(indexId = 'vision-board'): AddressRef {
  return recordIndexRef(REPORT_SPEC, indexId);
}

/** Every saved report (active + archived); a malformed descriptor is skipped. */
export function readReports(graph: GroupGraph, indexRef: AddressRef): StoredReport[] {
  return readRecords(graph, indexRef, REPORT_SPEC).map(toReport);
}
export function readActiveReports(graph: GroupGraph, indexRef: AddressRef): StoredReport[] {
  return readActiveRecords(graph, indexRef, REPORT_SPEC).map(toReport);
}
export function readArchivedReports(graph: GroupGraph, indexRef: AddressRef): StoredReport[] {
  return readArchivedRecords(graph, indexRef, REPORT_SPEC).map(toReport);
}
export function getReport(graph: GroupGraph, indexRef: AddressRef, memberId: string): StoredReport | undefined {
  const r = getRecord(graph, indexRef, memberId, REPORT_SPEC);
  return r ? toReport(r) : undefined;
}

/** Save a report descriptor into the library (add-or-update by memberId; preserves the archived flag). */
export function saveReport(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; reportId: string; name: string; descriptor: ReportDescriptor; savedAt?: number },
): GroupGraph {
  return saveRecord(graph, indexRef, { memberId: args.memberId, recordId: args.reportId, name: args.name, record: args.descriptor, savedAt: args.savedAt }, REPORT_SPEC);
}

export function renameReport(graph: GroupGraph, indexRef: AddressRef, memberId: string, name: string): GroupGraph {
  return renameRecord(graph, indexRef, memberId, name);
}
export function archiveReport(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return archiveRecord(graph, indexRef, memberId);
}
export function restoreReport(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return restoreRecord(graph, indexRef, memberId);
}
