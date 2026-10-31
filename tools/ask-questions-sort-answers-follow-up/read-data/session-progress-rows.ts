// packages/ask-questions-sort-answers-follow-up/read-data/session-progress-rows.ts
//
// Purpose: the READ view that turns a respondent's folded journal history
// (FoldedSession[] from fold-answer-facts.ts) into ordered per-session PROGRESS
// ROWS — the shape a "your progress over time" surface reads (one row per
// session/submission, oldest→newest). This is the read counterpart a progress /
// mastery dashboard needs: the practice journal writes answer-facts, foldAnswerFacts
// reassembles them into sessions, and THIS folds those sessions into a time series.
//
// Generic + framework-agnostic + zero I/O. It NEVER enumerates the caller's
// questions or semantic fields (focus/goals/…). The mapping from output field
// name → source questionId is DATA (fieldMap); a new tracked field is a data row,
// never code (L090). It produces a NEUTRAL {id,label,fields} record shape — it does
// NOT import any dashboard/projection package (decoupled; the shape is a plain
// contract any RecordProjectionView can read).

import type { FoldedSession } from './fold-answer-facts.ts';

/**
 * A neutral projection row: id + label + flat fields. Matches the generic
 * {id,label,fields} record shape a RecordProjectionView reads. Deliberately not
 * imported from any dashboard package — the shape is the contract, not a coupling.
 */
export interface SessionProgressRow {
  id: string;
  label: string;
  fields: Record<string, unknown>;
}

/**
 * DATA map: output field name -> the questionId whose answered value supplies it.
 * The caller (Society) names its own questions and fields; this module reads the
 * map, it never hardcodes a field (L090). Absent questions simply omit that field
 * (honest-degrade, never a fabricated value).
 */
export type ProgressFieldMap = Record<string, string>;

export interface FoldSessionsToRowsOptions {
  /**
   * Row label source: 'answeredAt' (the session date) or 'ordinal' (Session 1,
   * 2, …). Default 'answeredAt', falling back to the ordinal when a session has
   * no answeredAt so a row is never label-less.
   */
  labelFrom?: 'answeredAt' | 'ordinal';
  /** Ordinal prefix when labelFrom falls back to (or is) an ordinal. Default 'Session'. */
  ordinalLabel?: string;
}

/** Sessions with a timestamp sort oldest→newest; timestamp-less sessions keep
 *  stable input order AFTER the timestamped ones (they are the least-known). */
function byAnsweredAtAscending(a: FoldedSession, b: FoldedSession): number {
  if (a.answeredAt && b.answeredAt) return a.answeredAt < b.answeredAt ? -1 : a.answeredAt > b.answeredAt ? 1 : 0;
  if (a.answeredAt && !b.answeredAt) return -1;
  if (!a.answeredAt && b.answeredAt) return 1;
  return 0;
}

/**
 * Fold a respondent's sessions into ordered progress rows.
 *
 * - One row per session, oldest→newest by answeredAt (stable for ties / missing ts).
 * - Each row's `fields` are populated from that session's answers via `fieldMap`
 *   (outputField -> questionId). A mapped question the session didn't answer is
 *   omitted from that row's fields (never fabricated).
 * - `answeredAt` is always echoed into fields as `answeredAt` (the time axis a
 *   trend reads), when present.
 * - Row `id` is the session's submissionId (stable) or the ordinal when a form
 *   carried no submissionId (one-shot); `label` follows `labelFrom`.
 *
 * Pass the already-narrowed sessions for ONE respondent (use foldAnswerFacts's
 * respondentId filter first) — this function does not filter by respondent.
 */
export function foldSessionsToRows(
  sessions: readonly FoldedSession[],
  fieldMap: ProgressFieldMap,
  opts: FoldSessionsToRowsOptions = {},
): SessionProgressRow[] {
  const labelFrom = opts.labelFrom ?? 'answeredAt';
  const ordinalLabel = opts.ordinalLabel ?? 'Session';

  const ordered = [...sessions].sort(byAnsweredAtAscending);

  return ordered.map((session, index) => {
    const ordinal = index + 1;
    const fields: Record<string, unknown> = {};

    for (const [outField, questionId] of Object.entries(fieldMap)) {
      if (Object.prototype.hasOwnProperty.call(session.answers, questionId)) {
        fields[outField] = session.answers[questionId];
      }
    }
    if (session.answeredAt) fields.answeredAt = session.answeredAt;

    const ordinalText = `${ordinalLabel} ${ordinal}`;
    const label = labelFrom === 'answeredAt' ? session.answeredAt ?? ordinalText : ordinalText;
    const id = session.submissionId !== '' ? session.submissionId : `session-${ordinal}`;

    return { id, label, fields };
  });
}
