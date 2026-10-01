// packages/ask-questions-sort-answers-follow-up/read-data/fill-screen-model.ts
//
// The Physics of the CAPTURE stage: given a form's question descriptors, the
// question-type-capability registry, and the current answers, produce the
// ordered render rows (each resolved to an inputComponentKey + coerce + merged
// rules + current value + current error) and the overall validity. Pure +
// framework-agnostic + generic: it reads the registry, never enumerating
// question types. The React fill surface is a thin consumer of this model.

import {
  validateAnswer,
  type AnswerValidationRules,
  type CoerceKind,
} from './validate-answer.ts';
import type {
  QuestionDescriptor,
  QuestionTypeCapability,
} from './question-descriptor.ts';
import {
  resolveQuestionOptions,
  resolveQuestionSuggestions,
  type QuestionSuggestion,
} from './question-suggestions.ts';
import type { QuestionOption } from './question-input-contract.ts';
import { FALLBACK_INPUT_COMPONENT_KEY } from './question-descriptor.ts';

export interface FillRow {
  descriptor: QuestionDescriptor;
  inputComponentKey: string;
  coerce: CoerceKind;
  rules: AnswerValidationRules;
  value: unknown;
  /** Validation message to display now (null = nothing to show). */
  error: string | null;
  /** True validity of this answer, independent of whether the error is revealed. */
  valid: boolean;
  /** Current-feed suggestion chips (empty = render none; NEVER fallback constants). */
  suggestions: readonly QuestionSuggestion[];
  /** Effective bounded options: feed-derived when `options_source` is bound
   *  (empty feed = free input), else the descriptor's authored options. */
  resolvedOptions: readonly QuestionOption[] | undefined;
}

export interface FillScreenModel {
  rows: FillRow[];
  /** True when EVERY answer is valid (submit gate). */
  allValid: boolean;
  /** First questionId that is invalid (for scroll-to / focus on submit). */
  firstInvalidId: string | null;
}

export interface BuildFillOptions {
  /** Reveal validation errors even for untouched/empty answers (e.g. after a
   *  submit attempt). When false, an error is only shown for answers the user
   *  has actually entered, so the form does not scream "required" up front. */
  revealErrors?: boolean;
  /** Current named feed values (input_name → rows), resolved by the caller
   *  through the existing bitfield-input-descriptor path. Blind: unknown or
   *  absent names simply produce no suggestions/options. */
  suggestionFeeds?: Readonly<Record<string, unknown>>;
}

type CapabilityLookup =
  | Map<string, QuestionTypeCapability>
  | Readonly<Record<string, QuestionTypeCapability>>;

function lookup(reg: CapabilityLookup, id: string): QuestionTypeCapability | undefined {
  return reg instanceof Map ? reg.get(id) : reg[id];
}

function isEntered(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Merge per-question validation overrides OVER the capability default rules. */
export function mergeRules(
  capabilityRules: AnswerValidationRules | undefined,
  overrides: Partial<AnswerValidationRules> | undefined,
): AnswerValidationRules {
  return { ...(capabilityRules ?? {}), ...(overrides ?? {}) };
}

export function buildFillScreenModel(
  questions: readonly QuestionDescriptor[],
  registry: CapabilityLookup,
  answers: Readonly<Record<string, unknown>>,
  options: BuildFillOptions = {},
): FillScreenModel {
  const reveal = options.revealErrors ?? false;
  let firstInvalidId: string | null = null;

  const rows: FillRow[] = questions.map((descriptor) => {
    const cap = lookup(registry, descriptor.questionTypeId);
    // Graceful: an unknown question type renders as text and coerces to string,
    // rather than dropping the question (mirrors resolveInputComponent fallback).
    const inputComponentKey = cap?.inputComponentKey ?? FALLBACK_INPUT_COMPONENT_KEY;
    const coerce: CoerceKind = cap?.coerce ?? 'string';
    // Fold the descriptor-level `required` flag into the validation rules so it
    // actually gates submit (allValid), not just the native input attribute — a
    // form author who sets `required: true` reasonably expects it to block submit.
    // An explicit `validation.required` (including `false`) takes precedence.
    const descriptorRules: Partial<AnswerValidationRules> = {
      ...(descriptor.required ? { required: true } : {}),
      ...(descriptor.validation ?? {}),
    };
    const rules = mergeRules(cap?.validate?.rules, descriptorRules);
    const suggestions = resolveQuestionSuggestions(descriptor.suggestion_source, options.suggestionFeeds);
    const resolvedOptions = descriptor.options_source
      ? resolveQuestionOptions(descriptor.options_source, options.suggestionFeeds)
      : descriptor.options;

    const value = answers[descriptor.questionId];
    const result = validateAnswer(value, coerce, rules);
    if (!result.ok && firstInvalidId === null) firstInvalidId = descriptor.questionId;

    const show = reveal || isEntered(value);
    return {
      descriptor,
      inputComponentKey,
      coerce,
      rules,
      value,
      valid: result.ok,
      error: result.ok || !show ? null : result.message ?? 'Invalid value',
      suggestions,
      resolvedOptions,
    };
  });

  return { rows, allValid: firstInvalidId === null, firstInvalidId };
}
