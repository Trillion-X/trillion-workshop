// tools/ask-questions-sort-answers-follow-up/steps/sitting.ts
//
// PURPOSE
//   A sitting: one person's one go at a form a page asks one question at a time (a booking page's questions, a form page's). It is
//   a `form-sitting` row of the pursuit's form_rows (who, which form, the step reached) and one answer-fact row per answer, kept as
//   each comes in. This file holds the steps every such page shares: the live form and its questions, the sitting, what it has
//   so far, the step to draw next, and the one answer. The step rules are the booking tool's (take-a-booking-one-step-at-a-time
//   read-data/booking-steps.mjs); the page that asks (a booking or a form page) adds its own steps (booking-steps.ts, form-page-steps.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Everything here is pure over a Store (store.ts): no login, no client, no table name outside the store's own statements.
//   2. A refusal says its reason in plain words and never repeats what the person gave.
//   3. An answer is checked by the step rules before it is kept; the same question answered again in the same sitting replaces its
//      answer; the sitting's step moves in the same write.
//   4. No form, question, page or word is named here: they are rows.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { nextStepOf, askedStep, checkAnswer } from '../../take-a-booking-one-step-at-a-time/read-data/booking-steps.mjs';
import { answerFactId, ANSWER_FACT_KIND } from '../do-work/answer-fact-writes.ts';
import { questionSequenceId } from '../do-work/save-question-sequence.ts';
import type { Store } from './store.ts';

export const SITTING_KIND = 'form-sitting';
export const sittingId = (submissionId: string) => `${SITTING_KIND}:${submissionId}`;

// The refusals of a sitting. A page replaces any of them with its own words.
export type Refusals = { unknown: string; finished: string; not_answering: string; [name: string]: string };
export const SITTING_REFUSALS: Refusals = {
  unknown: 'This booking is not known.',
  finished: 'This booking is already made.',
  not_answering: 'The booking is not waiting for an answer.',
};

type Question = { position: number; prompt: string; required: boolean; question: Record<string, any> };
export type Page = { formId: string; questions: Question[]; around?: unknown; [name: string]: any };
export type Sitting = { kind: string; formId: string; respondentId: string; submissionId: string; page: string; status: string; lastStep: string | null; startedAt: string; steps: Record<string, any>; [name: string]: any };
export type Progress = { email?: string; answers: Record<number, unknown>; slot?: string | null };

// A kept form (its question-sequence row's value), or null when there is none with questions.
export async function formOf(store: Store, formId: string) {
  const form = await store.value(questionSequenceId(formId));
  return form && Array.isArray(form.questions) ? form : null;
}

// A form's questions as a page asks them: each in the form's order (its position), its label as the prompt.
export function questionsOf(form: { questions: Record<string, any>[] }): Question[] {
  return form.questions.map(({ label, required, ...question }, position) => ({ position, prompt: label, required: required !== false, question }));
}

// A started sitting, or the refusal for one that is not there. `finished` is refused for one that is no longer started.
export async function sittingOf(store: Store, attemptId: string, refusals: Refusals = SITTING_REFUSALS): Promise<Sitting> {
  const sitting = await store.value(sittingId(attemptId), SITTING_KIND);
  if (!sitting) throw new Error(refusals.unknown);
  if (sitting.status !== 'started') throw new Error(refusals.finished);
  return sitting;
}

// A sitting started or kept: a kept one is read too, so a page can answer what a finished sitting reached.
export async function anySittingOf(store: Store, attemptId: string, refusals: Refusals = SITTING_REFUSALS): Promise<Sitting> {
  const sitting = await store.value(sittingId(attemptId), SITTING_KIND);
  if (!sitting) throw new Error(refusals.unknown);
  return sitting;
}

// What the sitting has so far, in the shape the step rules read (answers by the question's place in the form).
export async function progressOf(store: Store, page: Page, sitting: Sitting): Promise<Progress> {
  const facts = await store.factsOf(sitting.submissionId);
  const placeOf = new Map(page.questions.map(question => [question.question.questionId, question.position]));
  const answers: Record<number, unknown> = {};
  for (const fact of facts) if (placeOf.has(fact.questionId)) answers[placeOf.get(fact.questionId) as number] = fact.value;
  return { email: sitting.respondentId, answers, slot: sitting.steps?.slot ?? null };
}

// What the page draws for a step: for a question, its prompt as asked now and what its input needs (its type, options, other
// option, placeholder, help and bounds), never the rules' code.
export function stepView(page: Page, step: any, progress: Progress) {
  if (!step) return null;
  if (step.kind !== 'question') return { key: step.key, kind: step.kind };
  const asked = askedStep(page, step, progress);
  const { questionId, questionTypeId, options, multiple, other, placeholder, help, validation } = asked.question;
  return { key: step.key, kind: step.kind, position: step.position, prompt: asked.prompt, required: step.required, about: asked.about, question: { questionId, questionTypeId, options, multiple, other, placeholder, help, min: validation?.min, max: validation?.max } };
}

// One question: the answer is for the step the sitting is waiting at, checked, and kept as its own answer fact before the next
// step is named. `pageOf` reads the page a sitting was started on and `refusals` are the sitting's words.
export async function answerQuestion(
  store: Store,
  { attemptId, value, now = () => new Date().toISOString() }: { attemptId: string; value: unknown; now?: () => string },
  { pageOf, refusals = SITTING_REFUSALS }: { pageOf: (sitting: Sitting) => Promise<Page>; refusals?: Refusals },
) {
  const sitting = await sittingOf(store, attemptId, refusals);
  const page = await pageOf(sitting);
  const progress = await progressOf(store, page, sitting);
  const step = nextStepOf(page, progress);
  if (step?.kind !== 'question') throw new Error(refusals.not_answering);
  const checked = checkAnswer(step, value);
  if (!checked.ok) throw new Error(checked.reason);
  const asked = askedStep(page, step, progress);
  const { questionId } = step.question;
  const fact = {
    kind: ANSWER_FACT_KIND, formId: sitting.formId, respondentId: sitting.respondentId, submissionId: sitting.submissionId, questionId,
    value: checked.value, words: checked.text, asked: asked.prompt, answered_at: now(), ...(asked.about ? { about: asked.about } : {}),
  };
  await store.apply([
    { kind: 'upsert', id: answerFactId(sitting.formId, sitting.respondentId, questionId, sitting.submissionId), type: ANSWER_FACT_KIND, value: fact },
    { kind: 'merge', id: sittingId(sitting.submissionId), changes: { lastStep: step.key } },
  ]);
  const later = { ...progress, answers: { ...progress.answers, [step.position]: checked.value } };
  return { next: stepView(page, nextStepOf(page, later), later) };
}
