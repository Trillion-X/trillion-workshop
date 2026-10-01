// packages/ask-questions-sort-answers-follow-up/read-data/question-suggestions.ts
//
// Pure, framework-agnostic resolution of DATA-bound question suggestion feeds.
// A QuestionFeedBinding names an input resolved by the EXISTING
// `bitfield-input-descriptor` mechanism; this module blindly walks the declared
// paths on each current row and returns suggestion chips. It has ZERO knowledge
// of any producer (visual-database, service-connections, presenter, model
// output, ...) and ZERO fallback constants: empty, stale, malformed,
// unauthorized, or absent feeds simply produce no suggestions and no options.

import type {
  QuestionFeedBinding,
  QuestionFeedPredicate,
} from './question-descriptor.ts';
import type { QuestionOption } from './question-input-contract.ts';

/** One resolved suggestion chip. Prefills the editable input ONLY. */
export interface QuestionSuggestion {
  label: string;
  value: string;
  /** Optional durable evidence/address ref from the source row. */
  evidenceRef?: string;
}

/** Blind path walk: objects only, never throws, undefined on any miss. */
function resolvePath(row: unknown, path: readonly string[]): unknown {
  let current: unknown = row;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function predicatePasses(row: unknown, predicate: QuestionFeedPredicate): boolean {
  const actual = resolvePath(row, predicate.path);
  const expected: unknown = Object.prototype.hasOwnProperty.call(predicate, 'equals')
    ? predicate.equals
    : true;
  if (expected === null || expected === undefined) return actual === expected;
  if (actual === null || actual === undefined) return false;
  if (actual === expected) return true;
  // Boolean coercion only for the explicit `true`/`false` DATA shape — never
  // truthy-matching (an unauthorized/pending row must NOT leak through).
  if (typeof expected === 'boolean') return actual === expected;
  if (typeof expected === 'string' || typeof expected === 'number') {
    return typeof actual === typeof expected && actual === expected;
  }
  return false;
}

/**
 * Resolve a question's suggestion chips from current named feeds.
 *
 * Hostile-input contract (gauntlet): absent/unauthorized feed, non-array stale
 * shape, malformed rows, empty label/value, failing predicates, duplicates,
 * and over-cap rows are dropped — and the result is ALWAYS `[]`, never any
 * fallback constant list.
 */
export function resolveQuestionSuggestions(
  source: QuestionFeedBinding | undefined,
  feeds: Readonly<Record<string, unknown>> | undefined,
): QuestionSuggestion[] {
  if (!source || typeof source.input_name !== 'string' || source.input_name.length === 0) return [];
  if (source.label_path.length === 0 || source.value_path.length === 0) return [];
  const raw = feeds?.[source.input_name];
  if (!Array.isArray(raw)) return [];

  const max =
    typeof source.max === 'number' && Number.isFinite(source.max) && source.max > 0
      ? Math.floor(source.max)
      : Number.POSITIVE_INFINITY;

  const seen = new Set<string>();
  const out: QuestionSuggestion[] = [];
  for (const row of raw) {
    if (out.length >= max) break;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const label = nonEmptyText(resolvePath(row, source.label_path));
    const value = nonEmptyText(resolvePath(row, source.value_path));
    if (label === null || value === null) continue;
    if (source.where && !source.where.every((p) => predicatePasses(row, p))) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const evidence = source.evidence_ref_path
      ? nonEmptyText(resolvePath(row, source.evidence_ref_path))
      : null;
    out.push(evidence === null ? { label, value } : { label, value, evidenceRef: evidence });
  }
  return out;
}

/**
 * Resolve capability-derived bounded options from a feed binding. When the
 * binding is present but the feed yields nothing, the result is an EMPTY list —
 * the caller renders free input, never static fallback options.
 */
export function resolveQuestionOptions(
  source: QuestionFeedBinding | undefined,
  feeds: Readonly<Record<string, unknown>> | undefined,
): QuestionOption[] | undefined {
  if (!source) return undefined;
  return resolveQuestionSuggestions(source, feeds).map((s) => ({ label: s.label, value: s.value }));
}
