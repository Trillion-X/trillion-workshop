// packages/ask-questions-sort-answers-follow-up/read-data/read-forms-data.ts
//
// Decode raw bitfield input entries (what useBitfieldData returns: an array of
// rows, each either `{payload: record}` or the record directly) into the typed
// shapes the capture pipeline consumes. Pure + framework-agnostic + defensive:
// malformed rows are dropped, never thrown on. Mirrors the journal-composition-
// editor decoder pattern (`row.payload ?? row`, then validate `kind`).

import {
  indexCapabilities,
  type AfterSavedActionDescriptor,
  type QuestionFeedBinding,
  type QuestionFeedPredicate,
  type QuestionDescriptor,
  type QuestionSequence,
  type QuestionTypeCapability,
} from './question-descriptor.ts';
import type { CoerceKind } from './validate-answer.ts';
import type { QuestionOption } from './question-input-contract.ts';

const CAPABILITY_KIND = 'question-type-capability';
const SEQUENCE_KIND = 'question-sequence';
const COERCE_KINDS: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'evidence-reference']);

function payloadOf(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const inner = (row as { payload?: unknown }).payload ?? row;
  return inner && typeof inner === 'object' && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function rowsOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function readOptions(raw: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const opts: QuestionOption[] = [];
  for (const o of raw) {
    if (o && typeof o === 'object' && typeof (o as QuestionOption).value === 'string') {
      const opt = o as QuestionOption;
      opts.push({ value: opt.value, label: typeof opt.label === 'string' ? opt.label : opt.value });
    }
  }
  return opts;
}

function readStringPath(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  const parts: string[] = [];
  for (const part of raw) {
    if (typeof part !== 'string' || part.length === 0) return null;
    parts.push(part);
  }
  return parts;
}

function readPredicates(raw: unknown): QuestionFeedPredicate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: QuestionFeedPredicate[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
    const path = readStringPath((p as Record<string, unknown>).path);
    if (path === null) return undefined;
    const record = p as Record<string, unknown>;
    out.push(
      Object.prototype.hasOwnProperty.call(record, 'equals')
        ? { path, equals: record.equals }
        : { path },
    );
  }
  return out;
}

/** Decode a suggestion/options feed binding (snake_case DATA; camelCase also
 *  accepted). Defensive: a binding without a real input name or usable paths
 *  is dropped (undefined), never half-preserved. */
function readFeedBinding(raw: unknown): QuestionFeedBinding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.input_name !== 'string' || value.input_name.length === 0) return undefined;
  const labelPath = readStringPath(value.label_path);
  const valuePath = readStringPath(value.value_path);
  if (labelPath === null || valuePath === null) return undefined;
  const evidencePath = readStringPath(value.evidence_ref_path);
  const where = readPredicates(value.where);
  const max =
    typeof value.max === 'number' && Number.isFinite(value.max) && value.max > 0
      ? value.max
      : undefined;
  return {
    input_name: value.input_name,
    label_path: labelPath,
    value_path: valuePath,
    ...(evidencePath ? { evidence_ref_path: evidencePath } : {}),
    ...(where ? { where } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

export function readCapabilityRows(raw: unknown): QuestionTypeCapability[] {
  const out: QuestionTypeCapability[] = [];
  for (const row of rowsOf(raw)) {
    const p = payloadOf(row);
    if (!p || p.kind !== CAPABILITY_KIND) continue;
    if (typeof p.questionTypeId !== 'string' || typeof p.inputComponentKey !== 'string') continue;
    const coerce: CoerceKind = typeof p.coerce === 'string' && COERCE_KINDS.has(p.coerce)
      ? (p.coerce as CoerceKind)
      : 'string';
    out.push({
      questionTypeId: p.questionTypeId,
      inputComponentKey: p.inputComponentKey,
      coerce,
      label: typeof p.label === 'string' ? p.label : undefined,
      validate:
        p.validate && typeof p.validate === 'object' && !Array.isArray(p.validate)
          ? (p.validate as QuestionTypeCapability['validate'])
          : undefined,
    });
  }
  return out;
}

/** Decode + index in one step — the shape the fill model + surface consume. */
export function readCapabilityRegistry(raw: unknown): Map<string, QuestionTypeCapability> {
  return indexCapabilities(readCapabilityRows(raw));
}

function readDescriptor(raw: unknown): QuestionDescriptor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.questionId !== 'string' || typeof d.questionTypeId !== 'string') return null;
  const afterSaved = readAfterSavedAction(d.after_saved ?? d.afterSaved);
  const suggestionSource = readFeedBinding(d.suggestion_source ?? d.suggestionSource);
  const optionsSource = readFeedBinding(d.options_source ?? d.optionsSource);
  return {
    questionId: d.questionId,
    questionTypeId: d.questionTypeId,
    label: typeof d.label === 'string' ? d.label : d.questionId,
    required: d.required === true,
    placeholder: typeof d.placeholder === 'string' ? d.placeholder : undefined,
    options: readOptions(d.options),
    ...(suggestionSource ? { suggestion_source: suggestionSource } : {}),
    ...(optionsSource ? { options_source: optionsSource } : {}),
    validation:
      d.validation && typeof d.validation === 'object' && !Array.isArray(d.validation)
        ? (d.validation as QuestionDescriptor['validation'])
        : undefined,
    ...(afterSaved ? { afterSaved } : {}),
  };
}

function readAfterSavedAction(raw: unknown): AfterSavedActionDescriptor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const actionRef = value.action_ref ?? value.actionRef;
  if (typeof value.owner !== 'string' || value.owner.length === 0) return null;
  if (typeof actionRef !== 'string' || actionRef.length === 0) return null;
  const input = value.input;
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return null;
  return {
    owner: value.owner,
    actionRef,
    input: (input as Record<string, unknown> | undefined) ?? {},
  };
}

function readPresentation(raw: unknown): QuestionSequence['presentation'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.mode !== 'string' || value.mode.length === 0) return undefined;
  const optionalText = (snake: string, camel: string): string | undefined => {
    const candidate = value[snake] ?? value[camel];
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  };
  return {
    mode: value.mode,
    backLabel: optionalText('back_label', 'backLabel'),
    nextLabel: optionalText('next_label', 'nextLabel'),
    submitLabel: optionalText('submit_label', 'submitLabel'),
  };
}

export function readQuestionSequences(raw: unknown): QuestionSequence[] {
  const out: QuestionSequence[] = [];
  for (const row of rowsOf(raw)) {
    const p = payloadOf(row);
    if (!p || p.kind !== SEQUENCE_KIND || typeof p.formId !== 'string') continue;
    const questions = Array.isArray(p.questions)
      ? p.questions.map(readDescriptor).filter((q): q is QuestionDescriptor => q !== null)
      : [];
    out.push({
      formId: p.formId,
      title: typeof p.title === 'string' ? p.title : p.formId,
      presentation: readPresentation(p.presentation),
      questions,
    });
  }
  return out;
}

/** Convenience: the first sequence (a surface bound to one form), or null. */
export function readFirstQuestionSequence(raw: unknown): QuestionSequence | null {
  return readQuestionSequences(raw)[0] ?? null;
}

/**
 * The sequence a surface is DATA-bound to, selected by `formId`, or null.
 *
 * A placeable-surface names WHICH form it fills (the generative primitive —
 * L069/L090): the surface carries a `sequenceId` and the fill component resolves
 * exactly that form, never "whatever happens to be first." When `sequenceId` is
 * absent the caller falls back to `readFirstQuestionSequence` (a single-form
 * app), so this is additive and backward-compatible.
 */
export function readQuestionSequenceById(
  raw: unknown,
  sequenceId: string | null | undefined,
): QuestionSequence | null {
  if (typeof sequenceId !== 'string' || sequenceId.length === 0) return null;
  return readQuestionSequences(raw).find((s) => s.formId === sequenceId) ?? null;
}
