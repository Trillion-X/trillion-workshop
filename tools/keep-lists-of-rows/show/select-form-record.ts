//
// The ONE non-trivial responsibility the record-form mount owns (per the Lane-E
// L124 convergence): pick the EXACT record a form edits. `RecordFormSurface`
// already does everything else generically — its fields come from
// `decodeVisualDatabaseModel` (which auto-discovers every payload key), compose/edit
// is decided by whether a `record` is present, and edit writes back to that
// record's OWN address via `buildRecordWrite`. So the only thing a mount must get
// right is WHICH record.
//
// A form surface names its target with a DATA `record_id` in `surfaceInput`:
//   - absent            → COMPOSE (a new-record form; `undefined` target)
//   - present + matches → EDIT that live record (exact id match — the wrong-record
//                          guard: no fuzzy/first-of-kind selection)
//   - present + no match→ COMPOSE with an honest signal (the record isn't in the
//                          live feed yet / was removed) — never edit the wrong one
//
// Pure + unit-testable. No React, no I/O.

import type { VisualDatabaseModel, VisualDatabaseRecord } from '@/packages/visual-database/read-data/visual-database';

/** Read the DATA `record_id` a form surface may declare in its `surfaceInput`. */
export function readFormRecordId(surfaceInput: unknown): string | null {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return null;
  const id = (surfaceInput as { record_id?: unknown }).record_id;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/** Read the DATA `submit_label` override (e.g. "Save changes" / "Create"). */
export function readFormSubmitLabel(surfaceInput: unknown): string | null {
  if (!surfaceInput || typeof surfaceInput !== 'object' || Array.isArray(surfaceInput)) return null;
  const label = (surfaceInput as { submit_label?: unknown }).submit_label;
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/**
 * Select the target record for an edit form. Returns `undefined` for COMPOSE (no
 * `record_id`, or a `record_id` that matches no live record — never silently edit a
 * different record). Exact id match only.
 */
export function selectFormRecord(model: VisualDatabaseModel, surfaceInput: unknown): VisualDatabaseRecord | undefined {
  const recordId = readFormRecordId(surfaceInput);
  if (!recordId) return undefined;
  return model.records.find((record) => record.id === recordId);
}

/**
 * Whether a form surface ASKED to edit (declared a `record_id`) but that record is
 * not present in the live model — so the mount can show an honest "not found"
 * state instead of silently dropping into compose. Distinct from a plain compose
 * surface (no `record_id` at all).
 */
export function isEditTargetMissing(model: VisualDatabaseModel, surfaceInput: unknown): boolean {
  const recordId = readFormRecordId(surfaceInput);
  if (!recordId) return false;
  return !model.records.some((record) => record.id === recordId);
}
