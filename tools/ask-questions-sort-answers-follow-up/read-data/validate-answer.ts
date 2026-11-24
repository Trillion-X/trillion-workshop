// packages/ask-questions-sort-answers-follow-up/read-data/validate-answer.ts
//
// Purpose: The Physics of answer capture — coerce a raw answer to its typed
// value and validate it against the question-type capability's `validate.rules`
// DATA. Framework-agnostic (zero React), generic (reads rules; never enumerates
// question types). Adding a question type does NOT change this function — it is
// driven entirely by the `question-type-capability` registry rows the package
// ships in `things-to-store-and-run.json`.
//
// Non-negotiable invariants:
//  - No `switch(questionTypeId)` / closed union (enum-dissolution, L090).
//  - `min`/`max` semantics are coerce-aware: string → length bounds; number →
//    value bounds. This matches the reused customer validation DATA shape
//    (`FormField.validation:{min,max,pattern,message}`) without redesigning it.
//  - Empty + optional = valid; empty + required = invalid. Coercion failure is
//    invalid regardless of `required`.
//  - A `picks` answer is checked against the question's own listed options (passed in
//    as `choice`), never against a list kept here: one pick or several, and the other
//    option's own words when it is picked. `min`/`max` count the picks.

import { isEvidenceReference, type EvidenceReference } from './evidence-reference.ts';

export type CoerceKind = 'string' | 'number' | 'boolean' | 'evidence-reference' | 'picks';

/** A picks answer: the values picked, and the person's own words when the other option is one of them. */
export interface Picks {
  picked: string[];
  other?: string;
}

/** What a picks answer is checked against: the question's options, one pick or several, and its other option. */
export interface ChoiceShape {
  options?: readonly { value: string; label?: string }[] | null;
  multiple?: boolean | null;
  other?: { value: string; label?: string } | null;
}

/** DATA carried on each `question-type-capability` row (payload.validate.rules)
 *  and/or overridden per-question on the scene node. */
export interface AnswerValidationRules {
  required?: boolean | null;
  /** string → min length; number → min value */
  min?: number | null;
  /** string → max length; number → max value */
  max?: number | null;
  /** string only — regex source tested against the coerced string */
  pattern?: string | null;
  /** custom message shown for ANY failure on this question */
  message?: string | null;
}

export interface CoerceResult {
  ok: boolean;
  value?: string | number | boolean | EvidenceReference | Picks;
}

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

const EMPTY = '';

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === EMPTY;
}

/** Coerce a raw answer to the typed value named by the capability's `coerce`. */
export function coerceAnswer(raw: unknown, coerce: CoerceKind): CoerceResult {
  switch (coerce) {
    case 'string':
      return { ok: true, value: isEmpty(raw) ? EMPTY : String(raw) };
    case 'number': {
      if (isEmpty(raw)) return { ok: true, value: undefined };
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'boolean': {
      if (raw === true || raw === 'true' || raw === 1) return { ok: true, value: true };
      if (raw === false || raw === 'false' || raw === 0) return { ok: true, value: false };
      if (isEmpty(raw)) return { ok: true, value: undefined };
      return { ok: false };
    }
    case 'evidence-reference':
      if (isEmpty(raw)) return { ok: true, value: undefined };
      return isEvidenceReference(raw) ? { ok: true, value: raw } : { ok: false };
    case 'picks':
      return coercePicks(raw);
    default:
      // coerce is a closed Physics set (string|number|boolean) — unreachable.
      return { ok: false };
  }
}

/** A picks answer from `{ picked, other? }`, a list of values or one value; empty is `undefined`. */
export function coercePicks(raw: unknown): CoerceResult {
  if (isEmpty(raw)) return { ok: true, value: undefined };
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { picked?: unknown }).picked : null;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) return { ok: false };
  const picked = [...new Set((list as string[]).map((item) => item.trim()).filter(Boolean))];
  if (picked.length === 0) return { ok: true, value: undefined };
  const words = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { other?: unknown }).other : undefined;
  if (words !== undefined && words !== null && typeof words !== 'string') return { ok: false };
  const other = typeof words === 'string' ? words.trim() : '';
  return { ok: true, value: other ? { picked, other } : { picked } };
}

/** Validate a raw answer against the capability's rules + coerce kind (and, for picks, the question's choice). */
export function validateAnswer(
  raw: unknown,
  coerce: CoerceKind,
  rules: AnswerValidationRules | null | undefined,
  choice?: ChoiceShape | null,
): ValidationResult {
  const r = rules ?? {};
  const fail = (fallback: string): ValidationResult => ({
    ok: false,
    message: r.message ?? fallback,
  });

  // 1. Coercion gate.
  const coerced = coerceAnswer(raw, coerce);
  if (!coerced.ok) return fail('Enter a valid value');

  // 2. Emptiness vs required.
  const empty = coerced.value === undefined || coerced.value === EMPTY;
  if (empty) {
    return r.required ? fail('This question is required') : { ok: true };
  }

  // 3. Bounds — coerce-aware.
  if (coerce === 'string') {
    const len = (coerced.value as string).length;
    if (r.min != null && len < r.min) return fail(`Must be at least ${r.min} characters`);
    if (r.max != null && len > r.max) return fail(`Must be at most ${r.max} characters`);
    if (r.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(r.pattern);
      } catch {
        return fail('Invalid validation pattern');
      }
      if (!re.test(coerced.value as string)) return fail('Does not match the required format');
    }
  } else if (coerce === 'number') {
    const num = coerced.value as number;
    if (r.min != null && num < r.min) return fail(`Must be at least ${r.min}`);
    if (r.max != null && num > r.max) return fail(`Must be at most ${r.max}`);
  } else if (coerce === 'picks') {
    const { picked, other } = coerced.value as Picks;
    const otherValue = choice?.other?.value;
    const listed = new Set([...(choice?.options ?? []).map((option) => option.value), ...(otherValue ? [otherValue] : [])]);
    if (picked.some((value) => !listed.has(value))) return fail('Pick from the answers shown');
    if (!choice?.multiple && picked.length > 1) return fail('Pick one answer');
    if (r.min != null && picked.length < r.min) return fail(`Pick at least ${r.min}`);
    if (r.max != null && picked.length > r.max) return fail(`Pick at most ${r.max}`);
    if (otherValue && picked.includes(otherValue) && !other) return fail(`Say what ${choice?.other?.label ?? otherValue} is`);
  }

  return { ok: true };
}
