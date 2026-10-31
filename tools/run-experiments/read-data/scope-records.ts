// tools/run-experiments/read-data/scope-records.ts
//
// scopeRecordsForObserver: scope ANY record list per observer from ONE
// self-describing scoping projection. The projection's rows are discriminated
// by entity_type: 'observer-source' (how to resolve the observer id from a
// cookie string), 'selection-surface' (candidate sets), 'decider' (score
// programs). A surface applies when every candidate_id names a record in the
// list; the decider picks one winner and the other candidates are removed.
// Consumers pass raw records + the projection + their environment's cookie
// string — they never touch surface/decider/observer vocabulary.

import { selectWinner } from './select.ts';
import type { SelectionSurface } from './candidate-set-schema.ts';
import type { DeciderProgram } from './decider-schema.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function recordList(projection: unknown): unknown[] {
  if (Array.isArray(projection)) return projection;
  if (isRecord(projection) && Array.isArray(projection.records)) return projection.records;
  return [];
}

/** Read a cookie value from a raw cookie header/document string. */
function cookieValue(cookieString: string, name: string): string {
  const target = `${name}=`;
  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) return decodeURIComponent(trimmed.slice(target.length));
  }
  return '';
}

/** One applied decision, for observability and exposure recording. */
export interface ScopedRecordDecision {
  surface_address: string;
  winner_id: string;
  hidden_ids: string[];
}

/** Result of scoping a record list for one observer. */
export interface ScopeRecordsResult<T> {
  records: T[];
  decisions: ScopedRecordDecision[];
  observer_id: string;
}

/**
 * Scope `records` for the observer resolved from `cookieString`, per the rows
 * of `scopingProjection`.
 *
 * Row kinds read from the projection (self-describing, open set):
 *   - `observer-source`  — `{cookie_name}`: which cookie carries the observer
 *                          id. No such row, or the cookie is absent → no
 *                          observer → records returned unchanged.
 *   - `selection-surface` — candidate sets; applies only when EVERY
 *                          candidate_id names a record in the list.
 *   - `decider`           — score programs, keyed by decider_id (matched with
 *                          or without a `decider:` ref prefix).
 */
export function scopeRecordsForObserver<T extends { id: string }>(
  records: readonly T[],
  scopingProjection: unknown,
  cookieString: string | undefined,
): ScopeRecordsResult<T> {
  const rows = recordList(scopingProjection);

  const surfaces: SelectionSurface[] = [];
  const deciders = new Map<string, DeciderProgram>();
  let observerCookieName = '';
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.entity_type === 'observer-source' && typeof row.cookie_name === 'string' && row.cookie_name.length > 0) {
      if (!observerCookieName) observerCookieName = row.cookie_name;
    } else if (row.entity_type === 'selection-surface' && Array.isArray(row.candidates)) {
      surfaces.push(row as unknown as SelectionSurface);
    } else if (row.entity_type === 'decider' && typeof row.decider_id === 'string') {
      deciders.set(row.decider_id, row as unknown as DeciderProgram);
    }
  }

  const observerId = observerCookieName && cookieString
    ? cookieValue(cookieString, observerCookieName)
    : '';
  if (!observerId || surfaces.length === 0) {
    return { records: [...records], decisions: [], observer_id: observerId };
  }

  const recordIds = new Set(records.map((record) => record.id));
  let visible = [...records];
  const decisions: ScopedRecordDecision[] = [];

  for (const surface of surfaces) {
    const candidateIds = surface.candidates.map((candidate) => candidate.candidate_id);
    if (candidateIds.length < 2) continue;
    if (!candidateIds.every((id) => recordIds.has(id))) continue;

    const bareRef = surface.decider_program_ref?.replace(/^decider:/, '');
    const decider = deciders.get(surface.decider_program_ref) ?? (bareRef ? deciders.get(bareRef) : undefined);
    if (!decider) continue;

    const winner = selectWinner(surface, [], decider, `${observerId}:${surface.address}`);
    if (!winner) continue;

    const losers = candidateIds.filter((id) => id !== winner.candidate_id);
    visible = visible.filter((record) => !losers.includes(record.id));
    decisions.push({
      surface_address: surface.address,
      winner_id: winner.candidate_id,
      hidden_ids: losers,
    });
  }

  return { records: visible, decisions, observer_id: observerId };
}
