import type { EvaluationResult } from './records';
import { isObject, validateAccessDecision } from './validate-records';

/** Reader for owner-written decision records; it never recomputes policy. */
export function readEvaluationFeed(rows: unknown): EvaluationResult[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const payload = isObject(row) && 'payload' in row ? row.payload : row;
    const checked = validateAccessDecision(payload);
    return checked.ok ? [checked.value] : [];
  });
}
