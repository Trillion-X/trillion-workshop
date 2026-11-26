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
import { nextStepOf, askedStep, checkAnswer, checkSpecOf, stepsOf } from '../../take-a-booking-one-step-at-a-time/read-data/booking-steps.mjs';
import { answerFactId, ANSWER_FACT_KIND } from '../do-work/answer-fact-writes.ts';
import { questionSequenceId } from '../do-work/save-question-sequence.ts';
import type { Store } from './store.ts';

export const SITTING_KIND = 'form-sitting';
export const sittingId = (submissionId: string) => `${SITTING_KIND}:${submissionId}`;

// A refusal that names its own HTTP status. Every refusal a page's steps throw is one (test/refusal-statuses.test.ts reads every
// throw), so none reaches the site without a status. A visitor's own state answers 400 (what they gave is not valid), 401 or 403,
// 404 (nothing is there) or 409 (the sitting or the time is not at the state asked for); serve-steps.ts passes those on, so the site
// answers that very status. A fault of ours (a store or a calendar that did not answer, a caller that left out what it must give)
// names 500, 502 or 503; serve-steps.ts leaves those as plain words and the door answers 502. The one helper every page's steps use.
export const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });

// The status of each named refusal of a sitting or a page, whatever words a page gives it.
export const REFUSAL_STATUS: Record<string, number> = { closed: 404, unknown: 404, finished: 409, not_answering: 409, out_of_order: 409, not_done: 409, someone_else: 403 };
export const refused = (refusals: Refusals, name: string) => refusal(refusals[name] ?? SITTING_REFUSALS[name], REFUSAL_STATUS[name]);

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
  if (!sitting) throw refused(refusals, 'unknown');
  if (sitting.status !== 'started') throw refused(refusals, 'finished');
  return sitting;
}

// A sitting started or kept: a kept one is read too, so a page can answer what a finished sitting reached.
export async function anySittingOf(store: Store, attemptId: string, refusals: Refusals = SITTING_REFUSALS): Promise<Sitting> {
  const sitting = await store.value(sittingId(attemptId), SITTING_KIND);
  if (!sitting) throw refused(refusals, 'unknown');
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

// The most answers one call may carry: a page closed with answers still unsent sends them in one call, in order.
export const MOST_ANSWERS_IN_ONE_CALL = 200;

// One answer, or `answers` (a list of { questionId, value }) kept one after the other: the first refused ends the call and the
// ones before it stay kept. Answers a call carries are checked one by one by the same rules as one answer.
export async function answerQuestions(
  store: Store,
  { attemptId, value, questionId, answers, now }: { attemptId: string; value?: unknown; questionId?: string; answers?: { questionId?: string; value: unknown }[]; now?: () => string },
  deps: { pageOf: (sitting: Sitting) => Promise<Page>; refusals?: Refusals },
) {
  if (answers === undefined) return answerQuestion(store, { attemptId, value, questionId, now }, deps);
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MOST_ANSWERS_IN_ONE_CALL) throw refusal((deps.refusals ?? SITTING_REFUSALS).not_answering, 400);
  let last: Awaited<ReturnType<typeof answerQuestion>> | null = null;
  for (const item of answers) last = await answerQuestion(store, { attemptId, value: item.value, questionId: item.questionId, now }, deps);
  return last!;
}

// The whole form as plain data the page holds, so it can check each answer and move to the next question without asking the
// server: each question as it is first drawn, how its answer is checked (the server's own spec, so a page that passes an answer is
// never refused by the rules it was given), and `conditional` when the question is asked only if earlier answers say so or is
// worded from one (those rules run on the server, so the page waits for the server before it moves to such a question).
export function definitionOf(page: Page) {
  const empty: Progress = { answers: {} };
  return {
    questions: stepsOf(page).filter((step: any) => step.kind === 'question').map((step: any) => ({
      next: stepView(page, step, empty),
      check: checkSpecOf(step),
      conditional: Boolean(step.question.showWhen || step.question.hideWhen || step.question.about),
    })),
  };
}

// An answer sent for a question the sitting is no longer waiting at: it is the same answer sent again (a retry after a lost
// reply), which changes nothing, or it is refused; it is never kept as the answer to another question.
function sentAgain(page: Page, progress: Progress, questionId: string, value: unknown, refusals: Refusals) {
  const asked = stepsOf(page).find((step: any) => step.kind === 'question' && step.question.questionId === questionId);
  const checked = asked ? checkAnswer(asked, value) : null;
  const kept = asked ? progress.answers[asked.position] : undefined;
  if (!checked?.ok || kept === undefined || JSON.stringify(kept) !== JSON.stringify(checked.value)) throw refusal(refusals.out_of_order ?? 'That answer came out of order.', REFUSAL_STATUS.out_of_order);
  return { answered: questionId, next: stepView(page, nextStepOf(page, progress), progress) };
}

// One question: the answer is for the step the sitting is waiting at, checked, and kept as its own answer fact before the next
// step is named. `questionId`, when the page names it (as `named`), must be that step's question (see sentAgain). `pageOf` reads the page a
// sitting was started on and `refusals` are the sitting's words.
export async function answerQuestion(
  store: Store,
  { attemptId, value, questionId: named, now = () => new Date().toISOString() }: { attemptId: string; value: unknown; questionId?: string; now?: () => string },
  { pageOf, refusals = SITTING_REFUSALS }: { pageOf: (sitting: Sitting) => Promise<Page>; refusals?: Refusals },
) {
  const sitting = await sittingOf(store, attemptId, refusals);
  const page = await pageOf(sitting);
  const progress = await progressOf(store, page, sitting);
  const step = nextStepOf(page, progress);
  if (named && (step?.kind !== 'question' || step.question.questionId !== named)) return sentAgain(page, progress, named, value, refusals);
  if (step?.kind !== 'question') throw refused(refusals, 'not_answering');
  const checked = checkAnswer(step, value);
  if (!checked.ok) throw refusal(checked.reason, 400);
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
  return { answered: questionId, next: stepView(page, nextStepOf(page, later), later) };
}
