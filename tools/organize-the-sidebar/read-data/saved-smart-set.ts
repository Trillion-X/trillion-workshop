// packages/group/read-data/saved-smart-set.ts
//
// The persistence store for saved SMART SETS — a named, re-resolving selection. Where a saved VIEW
// (board-view-store) bookmarks a CAMERA and a saved REPORT (saved-report-store) bookmarks a REDUCTION, a smart
// set bookmarks a QUERY: a `FacetSelection` (the values the user picked per dimension) that RE-RESOLVES against
// the live board every time it is applied — so "my in-progress ideas" keeps meaning the right cards as the board
// changes, instead of freezing a stale id list. It is the THIRD consumer of the generic named-record-index
// (b181) — a ~30-line SPEC + thin wrappers, NOT a second copy of the save/list/archive fold (L100) — and it
// resolves through `filterByFacets` (facet-filter.ts), owning NO matching logic of its own (SSOT). Fail-closed:
// a stored payload that isn't a clean `Record<string, string[]>` selection is rejected by `parseSmartQuery`, so
// a malformed smart set never surfaces. No I/O, no React, no Date/random — the caller supplies `savedAt`.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { type AddressRef, type GroupGraph } from '../../ui/show/group/group-graph';
import { differenceIds, intersectIds } from './selection-algebra';
import type { BoardItem } from './group-board-model';
import { type FacetSelection, type FacetExtractors, filterByFacets, hasActiveFacets } from './facet-filter';
import {
  recordIndexRef,
  readRecords,
  readRejectedRecords,
  readActiveRecords,
  readArchivedRecords,
  getRecord,
  saveRecord,
  renameRecord,
  archiveRecord,
  restoreRecord,
  type RecordStoreSpec,
  type StoredRecord,
} from './named-record-index';

/** A saved smart set's payload — the faceted query it re-runs. Kept as its own object (not a bare
 *  FacetSelection) so the stored shape can grow (a future `logic:'all'|'any'`) without a migration. */
export interface SmartQuery {
  readonly selection: FacetSelection;
}

/** Own-key guard — a persisted selection is JSON that may carry an own `__proto__`/`constructor` key; only
 *  accept plain string→string[] entries and drop everything else (fail-closed, never throws). */
function parseSelection(value: unknown): FacetSelection | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, readonly string[]> = Object.create(null);
  for (const key of Object.keys(value)) {
    const vals = (value as Record<string, unknown>)[key];
    if (!Array.isArray(vals)) return null;
    if (!vals.every((v) => typeof v === 'string')) return null;
    out[key] = vals as string[];
  }
  return out;
}

/** Strictly validate an unknown stored payload as a SmartQuery; null on any violation (never throws). */
export function parseSmartQuery(value: unknown): SmartQuery | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const selection = parseSelection((value as Record<string, unknown>).selection);
  return selection ? { selection } : null;
}

/** A compact human label of a query — "tag: idea, planning · status: done", or "everything" when unconstrained.
 *  Used as the fallback name a member lacks a stored name (save always supplies one). Deterministic (key order). */
export function smartQueryText(q: SmartQuery): string {
  const parts: string[] = [];
  for (const key of Object.keys(q.selection)) {
    const vals = q.selection[key];
    if (vals && vals.length > 0) parts.push(`${key}: ${vals.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'everything';
}

/** A stable-ish key derived from the query (only used when a member lacks a stored id — save always supplies). */
function smartQueryKey(q: SmartQuery): string {
  return smartQueryText(q);
}

/** True iff the query imposes at least one constraint (an empty smart set would select the whole board). */
export function smartQueryIsEmpty(q: SmartQuery): boolean {
  return !hasActiveFacets(q.selection);
}

/** RE-RESOLVE a smart set against the CURRENT board: the memberIds of every item matching the query, using the
 *  caller-injected facet extractors (the leaf stays blind to which dimensions exist — L098). Pure. */
export function resolveSmartSet(items: readonly BoardItem[], q: SmartQuery, extractors: FacetExtractors<BoardItem>): string[] {
  return filterByFacets(items, q.selection, extractors).map((it) => it.memberId);
}

/** Compare live membership through the existing matcher and ordered set algebra. Never modifies cards. */
export function compareSmartSet(items: readonly BoardItem[], before: SmartQuery, after: SmartQuery, extractors: FacetExtractors<BoardItem>) {
  const beforeIds = resolveSmartSet(items, before, extractors);
  const afterIds = resolveSmartSet(items, after, extractors);
  return { beforeIds, afterIds, addedIds: differenceIds(afterIds, beforeIds), removedIds: differenceIds(beforeIds, afterIds), retainedIds: intersectIds(beforeIds, afterIds) };
}

export function sameSmartQuery(a: SmartQuery, b: SmartQuery): boolean {
  const keys = Object.keys(a.selection).sort();
  return JSON.stringify(keys) === JSON.stringify(Object.keys(b.selection).sort())
    && keys.every(key => JSON.stringify(a.selection[key]) === JSON.stringify(b.selection[key]));
}

const SMART_SET_SPEC: RecordStoreSpec<SmartQuery> = {
  indexFamily: 'group.smart-set-index',
  nodeFamily: 'group.smart-set',
  partKey: 'smart-set',
  kind: 'smart-set',
  parseRecord: parseSmartQuery,
  idOf: (q) => smartQueryKey(q),
  nameOf: (q) => smartQueryText(q),
};

/** One saved smart set decoded from an index member — the query plus its library metadata. */
export interface StoredSmartSet {
  readonly memberId: string;
  readonly smartSetId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly query: SmartQuery;
  readonly savedAt?: number;
}

function toSmartSet(r: StoredRecord<SmartQuery>): StoredSmartSet {
  return { memberId: r.memberId, smartSetId: r.recordId, name: r.name, archived: r.archived, query: r.record, ...(r.savedAt !== undefined ? { savedAt: r.savedAt } : {}) };
}

/** The smart-set-index ref for a surface (default vision-board). Distinct family from views/reports/collections. */
export function smartSetIndexRef(indexId = 'vision-board'): AddressRef {
  return recordIndexRef(SMART_SET_SPEC, indexId);
}

/** Every saved smart set (active + archived); a malformed query is skipped. */
export function readSmartSets(graph: GroupGraph, indexRef: AddressRef): StoredSmartSet[] {
  return readRecords(graph, indexRef, SMART_SET_SPEC).map(toSmartSet);
}

/** Invalid active queries remain visible, but have no executable query value. */
export function readUnavailableSmartSets(graph: GroupGraph, indexRef: AddressRef) {
  return readRejectedRecords(graph, indexRef, SMART_SET_SPEC).filter(record => !record.archived);
}
export function readActiveSmartSets(graph: GroupGraph, indexRef: AddressRef): StoredSmartSet[] {
  return readActiveRecords(graph, indexRef, SMART_SET_SPEC).map(toSmartSet);
}
export function readArchivedSmartSets(graph: GroupGraph, indexRef: AddressRef): StoredSmartSet[] {
  return readArchivedRecords(graph, indexRef, SMART_SET_SPEC).map(toSmartSet);
}
export function getSmartSet(graph: GroupGraph, indexRef: AddressRef, memberId: string): StoredSmartSet | undefined {
  const r = getRecord(graph, indexRef, memberId, SMART_SET_SPEC);
  return r ? toSmartSet(r) : undefined;
}

/** Save a smart set into the library (add-or-update by memberId; preserves the archived flag). */
export function saveSmartSet(
  graph: GroupGraph,
  indexRef: AddressRef,
  args: { memberId: string; smartSetId: string; name: string; query: SmartQuery; savedAt?: number },
): GroupGraph {
  return saveRecord(graph, indexRef, { memberId: args.memberId, recordId: args.smartSetId, name: args.name, record: args.query, savedAt: args.savedAt }, SMART_SET_SPEC);
}

export function renameSmartSet(graph: GroupGraph, indexRef: AddressRef, memberId: string, name: string): GroupGraph {
  return renameRecord(graph, indexRef, memberId, name);
}

/** Replace only the reviewed query; retain current identity, name, saved metadata and archive state. */
export function replaceSmartSetQuery(graph: GroupGraph, indexRef: AddressRef, memberId: string, expected: SmartQuery, replacement: SmartQuery): { graph: GroupGraph; error: string | null } {
  const current = getSmartSet(graph, indexRef, memberId);
  const query = parseSmartQuery(replacement);
  if (!query) return { graph, error: 'These filters could not be read. Your saved query is unchanged.' };
  if (!current || current.archived || !sameSmartQuery(current.query, expected)) {
    return { graph, error: 'This saved query changed. Compare its filters again before saving.' };
  }
  return { graph: saveSmartSet(graph, indexRef, { memberId, smartSetId: current.smartSetId, name: current.name, query, savedAt: current.savedAt }), error: null };
}
export function archiveSmartSet(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return archiveRecord(graph, indexRef, memberId);
}
export function restoreSmartSet(graph: GroupGraph, indexRef: AddressRef, memberId: string): GroupGraph {
  return restoreRecord(graph, indexRef, memberId);
}
