// packages/ask-questions-sort-answers-follow-up/read-data/question-descriptor.ts
//
// Self-describing DATA shapes for the ASK + CAPTURE stages. A form is a
// composition scene record PLUS an ordered list of question descriptors (plan
// §7.3). The fill handler iterates descriptors; it never enumerates question
// types — it looks each one up in the question-type-capability registry.

import type {
  AnswerValidationRules,
  CoerceKind,
} from './validate-answer.ts';
import type { QuestionOption } from './question-input-contract.ts';

/** Owner action requested only after this question's answer is durably saved. */
export interface AfterSavedActionDescriptor {
  owner: string;
  actionRef: string;
  input: Readonly<Record<string, unknown>>;
}

/**
 * A generic DATA binding from one question to rows in a named current feed.
 * The input_name is resolved through the EXISTING `bitfield-input-descriptor`
 * mechanism (a normal published input row binds the name to any authorized
 * value address). This package never knows — or cares — which producer owns
 * the feed: label/value/evidence are extracted by blind path, and optional
 * `where` predicates filter rows. There are NO fallback constants anywhere:
 * an empty, stale, malformed, unauthorized, or absent feed yields zero rows.
 */
export interface QuestionFeedBinding {
  /** The named input a surface resolves via `useBitfieldData(input_name)`. */
  input_name: string;
  /** Path to the human chip label on each feed row. */
  label_path: readonly string[];
  /** Path to the value a chip prefills into the editable answer. */
  value_path: readonly string[];
  /** Optional path to an evidence/address ref carried with the suggestion. */
  evidence_ref_path?: readonly string[];
  /** Optional generic row predicates — every match must pass. */
  where?: readonly QuestionFeedPredicate[];
  /** Optional cap on returned suggestions (positive integer). */
  max?: number;
}

/** One generic predicate over a feed row: the value at `path` must deep-equal `equals`. */
export interface QuestionFeedPredicate {
  path: readonly string[];
  equals?: unknown;
}

/** One question in a form's ordered sequence (self-describing). */
export interface QuestionDescriptor {
  questionId: string;
  /** Discriminant string resolved against the capability registry (NOT an enum). */
  questionTypeId: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  /** Bounded-choice options (choice questions). */
  options?: readonly QuestionOption[];
  /** OPTIONAL current-feed suggestion chips. Chips prefill the editable input
   *  ONLY — they never advance, save, or submit. No feed → no chips (never
   *  fallback constants). */
  suggestion_source?: QuestionFeedBinding;
  /** OPTIONAL capability-derived bounded options. When present, options come
   *  ONLY from the bound feed; an absent feed yields NO options (the question
   *  behaves as free input), never static fallback constants. */
  options_source?: QuestionFeedBinding;
  /** Per-question validation overrides, merged OVER the capability defaults. */
  validation?: Partial<AnswerValidationRules>;
  afterSaved?: AfterSavedActionDescriptor;
}

/** The input a question whose type is in no registry row falls back to (it coerces to a string). */
export const FALLBACK_INPUT_COMPONENT_KEY = 'text';

/** The registry row payload (things-to-store-and-run.json `question-type-capability`). */
export interface QuestionTypeCapability {
  questionTypeId: string;
  inputComponentKey: string;
  coerce: CoerceKind;
  label?: string;
  validate?: { rules?: AnswerValidationRules };
}

/** A form: an ordered question sequence (the scene revision stores the same
 *  questions as Component nodes for layout; this is the handler-facing list). */
export interface QuestionSequence {
  formId: string;
  title: string;
  presentation?: {
    mode: string;
    backLabel?: string;
    nextLabel?: string;
    submitLabel?: string;
  };
  questions: readonly QuestionDescriptor[];
}

/** Index a list of capability rows by questionTypeId for O(1) lookup. */
export function indexCapabilities(
  rows: readonly QuestionTypeCapability[],
): Map<string, QuestionTypeCapability> {
  const m = new Map<string, QuestionTypeCapability>();
  for (const r of rows) m.set(r.questionTypeId, r);
  return m;
}
