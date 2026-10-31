// packages/ask-questions-sort-answers-follow-up/read-data/results-model.ts
//
// The operator's RESULTS projection: decode the segment-assignment facts written
// at DECIDE time into respondent rows + a per-segment summary. Pure + generic —
// it reads the facts, never enumerating segments (segments are DATA). Renders
// the operator's "who answered, their score, their group" view. Honest-empty
// until real submissions exist (no fabricated rows).

import { SEGMENT_ASSIGNMENT_KIND } from '../do-work/segment-assignment-writes.ts';

export interface ResultRow {
  respondentId: string;
  formId: string;
  segmentId: string | null;
  score: number;
  decidedAt: string;
}

export interface ResultsSummary {
  total: number;
  /** segmentId (or "unsegmented") -> count. Data-driven; no segment enum. */
  bySegment: Record<string, number>;
}

export interface ResultsModel {
  rows: ResultRow[];
  summary: ResultsSummary;
}

const UNSEGMENTED = 'unsegmented';

function payloadOf(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const inner = (row as { payload?: unknown }).payload ?? row;
  return inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

/** Decode segment-assignment facts into result rows (drops malformed rows). */
export function readSegmentAssignments(raw: unknown, formId?: string): ResultRow[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: ResultRow[] = [];
  for (const row of rows) {
    const p = payloadOf(row);
    if (!p || p.kind !== SEGMENT_ASSIGNMENT_KIND) continue;
    if (typeof p.respondentId !== 'string' || typeof p.formId !== 'string') continue;
    if (formId !== undefined && p.formId !== formId) continue;
    out.push({
      respondentId: p.respondentId,
      formId: p.formId,
      segmentId: typeof p.segmentId === 'string' ? p.segmentId : null,
      score: typeof p.score === 'number' ? p.score : 0,
      decidedAt: typeof p.decided_at === 'string' ? p.decided_at : '',
    });
  }
  return out;
}

/** Summarize rows into a per-segment count (data-driven). */
export function summarize(rows: readonly ResultRow[]): ResultsSummary {
  const bySegment: Record<string, number> = {};
  for (const r of rows) {
    const key = r.segmentId ?? UNSEGMENTED;
    bySegment[key] = (bySegment[key] ?? 0) + 1;
  }
  return { total: rows.length, bySegment };
}

/** Decode + summarize in one step; newest decision first. */
export function buildResultsModel(raw: unknown, formId?: string): ResultsModel {
  const rows = readSegmentAssignments(raw, formId).sort((a, b) =>
    a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0,
  );
  return { rows, summary: summarize(rows) };
}
