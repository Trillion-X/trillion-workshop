// packages/ask-questions-sort-answers-follow-up/read-data/progress-model.ts
//
// The RESPONDENT'S OWN progress projection: decode this student's answer-facts
// (written by the live journal) into an ordered per-session time series — the
// "your progress over time" view. Pure + generic + zero I/O. Reuses the package's
// own read primitives (foldAnswerFacts -> foldSessionsToRows, single SSOT for the
// fold) so the SAME logic renders here as anywhere; it NEVER re-owns the fold and
// NEVER imports a dashboard package (the data owner renders its own history via
// shared ui — L098/L093). Honest-empty until the student actually submits (no
// fabricated sessions — L117). The output-field->questionId mapping and which
// field to trend are DATA (fieldMap / trendField), never hardcoded (L090).

import { foldAnswerFacts, type AnswerFactRow } from './fold-answer-facts.ts';
import { foldSessionsToRows, type ProgressFieldMap, type SessionProgressRow } from './session-progress-rows.ts';

export interface ProgressTrend {
  /** The output field being charted (from trendField / first numeric). */
  field: string;
  /** The numeric series in session order (oldest -> newest). */
  points: number[];
}

export interface ProgressModel {
  /** One row per session, oldest -> newest. */
  rows: SessionProgressRow[];
  /** The numeric series to chart, or null when no field has ≥1 numeric reading. */
  trend: ProgressTrend | null;
  /** The most recent session's mapped fields (for a "latest" summary), or null. */
  latest: Record<string, unknown> | null;
  /** Number of sessions. */
  count: number;
}

export interface BuildProgressOptions {
  formId?: string;
  respondentId?: string;
  /** output field -> questionId (DATA). */
  fieldMap: ProgressFieldMap;
  /** Which output field to chart. Absent -> the first field with a numeric value. */
  trendField?: string;
}

/** The published-records collection is an array of payload-wrapped records; the
 *  answer-facts among them are exactly the AnswerFactRow shape foldAnswerFacts reads. */
function asRows(raw: unknown): AnswerFactRow[] {
  return Array.isArray(raw) ? (raw as AnswerFactRow[]) : [];
}

/** Choose the trend field: the explicit `trendField` if it carries a number in any
 *  row, else the first mapped field that does. Null when nothing is numeric. */
function pickTrend(rows: SessionProgressRow[], fieldMap: ProgressFieldMap, trendField?: string): ProgressTrend | null {
  const candidates = trendField ? [trendField, ...Object.keys(fieldMap)] : Object.keys(fieldMap);
  for (const field of candidates) {
    const points = rows
      .map((r) => r.fields[field])
      .filter((v): v is number => typeof v === 'number');
    if (points.length > 0) return { field, points };
  }
  return null;
}

/**
 * Build a respondent's progress model from the raw published-records feed.
 * Narrow to ONE respondent via options.respondentId (a progress view is per-student).
 */
export function buildProgressModel(raw: unknown, opts: BuildProgressOptions): ProgressModel {
  const sessions = foldAnswerFacts(asRows(raw), { formId: opts.formId, respondentId: opts.respondentId });
  const rows = foldSessionsToRows(sessions, opts.fieldMap);
  const trend = pickTrend(rows, opts.fieldMap, opts.trendField);
  const latest = rows.length > 0 ? rows[rows.length - 1].fields : null;
  return { rows, trend, latest, count: rows.length };
}
