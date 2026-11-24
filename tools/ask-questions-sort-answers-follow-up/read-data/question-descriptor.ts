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
  /** Picks questions: several picks allowed (default one). */
  multiple?: boolean;
  /** Picks questions: the option that asks for the person's own words when picked. */
  other?: QuestionOption;
  /** Help shown under the question. */
  help?: string;
  /** What the answer is about, read from an earlier answer: its picked label replaces `{name}` in the
   *  label and is kept with the answer, so the same question asked about another thing is another series. */
  about?: QuestionAbout;
  /** When the question is asked: a rule tree of the formula engine (tools/formula-engine: groups of rules, each a question id,
   *  an operator from its rule-operators.json and params), read over the answers so far as facts (answerFacts). Absent: always. */
  showWhen?: QuestionRuleTree;
  /** When the question is not asked, though showWhen holds: the same kind of rule tree. */
  hideWhen?: QuestionRuleTree;
}

/** A formula-engine rule tree: { kind: 'group', combinator: 'and' | 'or', negate, rules: [tree] } or
 *  { kind: 'rule', field: <questionId>, operator: <rule-operators.json id>, params }. Kept as the engine reads it. */
export type QuestionRuleTree = Readonly<Record<string, unknown>>;

/** The answers so far as the facts a rule tree reads, keyed by question id: a picks answer gives its picked values (a list), any
 *  other answer itself. An unanswered question gives no fact, so a rule about it does not hold (the engine's unknown). */
export function answerFacts(answers: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (value === undefined || value === null) continue;
    const picked = value && typeof value === 'object' && !Array.isArray(value) ? (value as { picked?: unknown }).picked : undefined;
    facts[questionId] = Array.isArray(picked) ? picked : value;
  }
  return facts;
}

/** Whether a question is asked given the answers so far (by question id). `holds` is the loaded formula engine's
 *  holds({ tree, facts }) -> boolean, given by the host (Node or a page loads the engine its own way). A question with a rule
 *  tree and no engine to read it is refused, never shown or skipped by guess. */
export function isAsked(
  question: QuestionDescriptor,
  answers: Readonly<Record<string, unknown>>,
  holds?: (request: { tree: QuestionRuleTree; facts: Record<string, unknown> }) => boolean,
): boolean {
  if (!question.showWhen && !question.hideWhen) return true;
  if (typeof holds !== 'function') throw new Error(`Question ${question.questionId} is asked only when its rules hold, and no rule engine was given to read them.`);
  const facts = answerFacts(answers);
  if (question.showWhen && !holds({ tree: question.showWhen, facts })) return false;
  return !(question.hideWhen && holds({ tree: question.hideWhen, facts }));
}

/** `name` is the word in the label ({name}) and the key kept with the answer; `fromQuestionId` the answer read. */
export interface QuestionAbout {
  name: string;
  fromQuestionId: string;
}

function labelOfPick(question: QuestionDescriptor | undefined, value: unknown): string | null {
  const picks = value && typeof value === 'object' && !Array.isArray(value) ? value as { picked?: unknown; other?: unknown } : null;
  const first = typeof value === 'string' ? value : Array.isArray(picks?.picked) ? picks.picked[0] : null;
  if (typeof first !== 'string' || !first) return null;
  if (question?.other?.value === first && typeof picks?.other === 'string' && picks.other.trim()) return picks.other.trim();
  return question?.options?.find((option) => option.value === first)?.label ?? first;
}

/** The question as it is asked now: its label with `{name}` filled from the earlier answer, and what it is about. */
export function resolveAbout(
  question: QuestionDescriptor,
  questions: readonly QuestionDescriptor[],
  answers: Readonly<Record<string, unknown>>,
): { label: string; about: Record<string, string> | null } {
  if (!question.about) return { label: question.label, about: null };
  const from = questions.find((item) => item.questionId === question.about?.fromQuestionId);
  const subject = labelOfPick(from, answers[question.about.fromQuestionId]);
  if (!subject) return { label: question.label, about: null };
  return { label: question.label.split(`{${question.about.name}}`).join(subject.toLowerCase()), about: { [question.about.name]: subject } };
}

/** An answer as words: picks by their labels joined with '; ' (the other option as '<label>: <words>'), the rest as given. */
export function answerText(question: QuestionDescriptor, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  const picks = value as { picked?: unknown; other?: unknown };
  if (!Array.isArray(picks.picked)) return JSON.stringify(value);
  return picks.picked.map((item) => {
    if (question.other?.value === item) return `${question.other.label}: ${typeof picks.other === 'string' ? picks.other : ''}`.trim();
    return question.options?.find((option) => option.value === item)?.label ?? String(item);
  }).join('; ');
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
