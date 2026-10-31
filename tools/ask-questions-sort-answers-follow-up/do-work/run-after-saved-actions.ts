// Owner-blind post-save action runner. Every question's DATA-declared
// `afterSaved` binding names WHICH owner package and WHICH workflow action
// receives the resolved input; this runner never enumerates owners, never
// adapts to any specific action's parameter shape, and never imports another
// package. Changed from the package: the caller hands in the dispatch (the
// package's default sent each request through the old engine's workflow
// slot); the records-door command writes each request as an owner-action
// request record. Adding a new post-save integration is
// purely a DATA edit: bind a question's `afterSaved` to a different
// {owner, actionRef, input}, with zero code change here.
//
// Template tokens in `input` values (leaves only, recursive over objects
// and arrays):
//   "$run.scope_ref"        , respondentId (the durable scope owner)
//   "$run.id"               , runId (must be present when referenced)
//   "$now"                  , now.toISOString()
//   "$now.epoch"            , now.getTime()
//   "$uuid"                 , newId()
//   "$answer.<questionId>"  , answers[questionId]
// Anything else is passed through verbatim (numbers, booleans, arrays,
// nested objects, strings that do not begin with `$`). A referenced token
// that cannot be resolved (missing runId, missing answer) fails closed
// with a descriptive error before any dispatch occurs.

import type {
  AfterSavedActionDescriptor,
  QuestionSequence,
} from '../read-data/question-descriptor.ts';

export interface AfterSavedActionRunInputs {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly respondentId: string;
  readonly runId?: string;
  readonly sequence: QuestionSequence;
  readonly now?: Date;
  readonly newId?: () => string;
}

export interface AfterSavedDispatchRequest {
  readonly owner: string;
  readonly actionRef: string;
  readonly input: Record<string, unknown>;
}

export type AfterSavedDispatch = (
  request: AfterSavedDispatchRequest,
) => Promise<unknown>;

interface TemplateContext {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly respondentId: string;
  readonly runId?: string;
  readonly now: Date;
  readonly newId: () => string;
}

const ANSWER_PREFIX = '$answer.';

function resolveTemplateString(token: string, ctx: TemplateContext): unknown {
  if (token === '$run.scope_ref') return ctx.respondentId;
  if (token === '$run.id') {
    if (!ctx.runId) throw new Error('afterSaved input references $run.id but no runId was provided.');
    return ctx.runId;
  }
  if (token === '$now') return ctx.now.toISOString();
  if (token === '$now.epoch') return ctx.now.getTime();
  if (token === '$uuid') return ctx.newId();
  if (token.startsWith(ANSWER_PREFIX)) {
    const questionId = token.slice(ANSWER_PREFIX.length);
    if (!questionId) throw new Error('afterSaved $answer token is missing a questionId.');
    if (!Object.prototype.hasOwnProperty.call(ctx.answers, questionId)) {
      throw new Error(`afterSaved input references $answer.${questionId} but no such answer exists.`);
    }
    return ctx.answers[questionId];
  }
  throw new Error(`Unknown afterSaved template token: ${token}`);
}

function resolveValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return resolveTemplateString(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, ctx));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      out[key] = resolveValue(source[key], ctx);
    }
    return out;
  }
  return value;
}

function resolveInput(
  descriptor: AfterSavedActionDescriptor,
  ctx: TemplateContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const key of Object.keys(descriptor.input)) {
    resolved[key] = resolveValue(descriptor.input[key], ctx);
  }
  return resolved;
}

function defaultUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Walk the sequence's questions in order. For each question that declares
 * `afterSaved`, resolve the DATA-templated input and hand the request to
 * `dispatch` (the caller's hand-off: the command writes each as a record).
 * Returns the ordered list of dispatched requests for callers
 * that want a receipt log.
 */
export async function runAfterSavedActions(
  inputs: AfterSavedActionRunInputs,
  dispatch: AfterSavedDispatch,
): Promise<AfterSavedDispatchRequest[]> {
  const now = inputs.now ?? new Date();
  const newId = inputs.newId ?? defaultUuid;
  const ctx: TemplateContext = {
    answers: inputs.answers,
    respondentId: inputs.respondentId,
    runId: inputs.runId,
    now,
    newId,
  };
  const receipts: AfterSavedDispatchRequest[] = [];
  for (const question of inputs.sequence.questions) {
    const hook = question.afterSaved;
    if (!hook) continue;
    const input = resolveInput(hook, ctx);
    const request: AfterSavedDispatchRequest = {
      owner: hook.owner,
      actionRef: hook.actionRef,
      input,
    };
    await dispatch(request);
    receipts.push(request);
  }
  return receipts;
}
