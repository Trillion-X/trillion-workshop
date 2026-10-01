// packages/ask-questions-sort-answers-follow-up/read-data/question-input-contract.ts
//
// Purpose: the ONE shared contract every question-input leaf implements. The
// fill-surface handler renders a question by looking up the leaf for its
// `inputComponentKey` (see show/inputs/index.ts) and passing these props. Leaves
// are presentational: they render the input and surface the `error` the handler
// computed via read-data/validate-answer.ts. They do NOT validate or know about
// other question types (separation of concerns; enum-dissolution at the map).

import type { CoerceKind } from './validate-answer.ts';

export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionInputProps {
  /** Stable id of the question being answered (used for input ids / a11y). */
  questionId: string;
  /** Human label shown above the input. */
  label: string;
  /** Current answer value (raw — leaves coerce for display only). */
  value: unknown;
  /** Emit a new raw answer value. The handler coerces + validates. */
  onChange: (value: unknown) => void;
  /** Ask the configured owner for a value; this input does not choose a source. */
  requestValue?: () => unknown | Promise<unknown>;
  /** Bounded-choice options (choice input). Ignored by free-value inputs. */
  options?: readonly QuestionOption[];
  /** Validation/UX hints mirrored from the question node DATA. */
  required?: boolean;
  placeholder?: string;
  /** Numeric bounds — meaning is coerce-aware (string=length, number=value). */
  min?: number | null;
  max?: number | null;
  /** The coerce kind from the capability row, for display formatting. */
  coerce?: CoerceKind;
  /** Validation message computed by the handler (null/undefined = valid). */
  error?: string | null;
}

export type QuestionInputComponent = (props: QuestionInputProps) => JSX.Element;
