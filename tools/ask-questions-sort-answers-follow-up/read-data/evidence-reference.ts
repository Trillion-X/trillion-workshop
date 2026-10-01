// packages/ask-questions-sort-answers-follow-up/read-data/evidence-reference.ts
//
// A deliberately small, source-agnostic boundary for evidence captured by an
// owner outside this package. The form does not inspect a recorder, file picker,
// service connection, or any other source-specific payload. It only verifies a
// JSON-safe wrapper and preserves the opaque `reference` object as the answer.

export const EVIDENCE_REFERENCE_KIND = 'question-answer.evidence-reference' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface EvidenceReference {
  kind: typeof EVIDENCE_REFERENCE_KIND;
  reference: { readonly [key: string]: JsonValue };
}

export interface DraftCorrelation {
  formId: string;
  respondentId: string;
  /** Allocated while the form is still a draft and reused as the submission id. */
  draftId: string;
  submissionId: string;
}

export interface EvidenceReferenceRequest extends DraftCorrelation {
  questionId: string;
}

export type RequestEvidenceReference = (
  request: EvidenceReferenceRequest,
) => unknown | Promise<unknown>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isJsonSafe(value: unknown, seen: Set<object>, budget: { remaining: number }, depth = 0): value is JsonValue {
  if (--budget.remaining < 0 || depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonSafe(entry, seen, budget, depth + 1))
    : isPlainRecord(value)
      && Object.keys(value).every((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return !!property && 'value' in property && isJsonSafe(property.value, seen, budget, depth + 1);
      });
  seen.delete(value);
  return valid;
}

/** Validate the generic wrapper without interpreting its owner-defined body. */
export function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (!isPlainRecord(value) || value.kind !== EVIDENCE_REFERENCE_KIND) return false;
  if (!isPlainRecord(value.reference) || Object.keys(value.reference).length === 0) return false;
  return isJsonSafe(value.reference, new Set<object>(), { remaining: 10000 });
}
