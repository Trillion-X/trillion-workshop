// tools/ask-questions-sort-answers-follow-up/steps/form-page-steps.ts
//
// PURPOSE
//   The steps of a form page: a page that asks a form one question at a time and is kept afterwards, with no calendar. A visitor
//   answers first, sees their result (the segment the form's rules put them in, and its follow-up), and keeps it by proving their
//   email with the sign-in. A member who is signed in answers as themselves and their result is kept as it is shown. Each step is one
//   function of a Store (store.ts) and answers JSON: `startSitting`, `answerFormQuestion`, `sittingNext`, `formResult`, `keepSitting`.
//   A form page is one form_rows row `form-page:<slug>` ({ kind: 'form-page', slug, formId, live, around, words, keep_on, keep_at }):
//   the form it asks, the steps around the questions (take-a-booking-one-step-at-a-time `around`, here { before: [], after: ['result'] }),
//   the page's words, the site whose sign-in keeps the answers (keep_on) and where a kept result is read there (keep_at). Until a
//   sitting is kept its respondent is the sitting itself (`visitor:<sitting>`); keeping it moves its facts to the proven email and
//   writes the decision the form tools make (submitFormAnswers: the segment assignment and any owner-action requests), together.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The email a sitting is kept under is the one the sign-in proved (the caller names it as `person`), never a value the page sends.
//   2. A sitting is kept by one person only: a sitting already kept under another email is refused (status 403); one kept under the
//      same email answers what it answered (keeping twice changes nothing).
//   3. No form, segment, tier or word is named here: the form, its rules and the page's words are rows.
//   4. The moves of keeping (answer facts to the email, the decision's rows, the sitting marked kept) are one write.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { nextStepOf } from '../../take-a-booking-one-step-at-a-time/read-data/booking-steps.mjs';
import { answerFactId, ANSWER_FACT_KIND } from '../do-work/answer-fact-writes.ts';
import { questionSequenceId } from '../do-work/save-question-sequence.ts';
import { submitFormAnswers } from '../do-work/form-tools.mjs';
import { SITTING_KIND, anySittingOf, answerQuestions, definitionOf, formOf, progressOf, questionsOf, refusal, sittingId, stepView, type Page, type Refusals, type Sitting } from './sitting.ts';
import type { Store, Write } from './store.ts';

export const FORM_PAGE_KIND = 'form-page';
export const formPageId = (slug: string) => `${FORM_PAGE_KIND}:${slug}`;
const VISITOR = 'visitor:';
// The rows that decide a sitting's segment and follow-up (the form tools read them from `rows`).
const DECISION_KINDS = ['score-rule', 'segment-rule', 'follow-up-sequence'] as const;

// The refusals a form page answers with, each replaceable by the page row's `words.refusals`.
export const FORM_PAGE_REFUSALS: Refusals = {
  closed: 'This page is not open.',
  unknown: 'These answers are not known. Start again.',
  finished: 'These answers are already kept.',
  not_answering: 'There is no question waiting.',
  not_done: 'Answer every question first.',
  someone_else: 'These answers are kept by someone else.',
};

type Clock = { now?: () => string; newId?: () => string };

// The live page with its form's questions: a page that is not live or names no kept form is closed.
export async function loadFormPage(store: Store, slug: string): Promise<Page & { slug: string; title: string | null; words: any; keep_on: string | null; keep_at: string | null; refusals: Refusals }> {
  const row = await store.value(formPageId(slug), FORM_PAGE_KIND);
  if (!row || row.live !== true) throw new Error(FORM_PAGE_REFUSALS.closed);
  const form = await formOf(store, row.formId ?? '');
  if (!form) throw new Error(FORM_PAGE_REFUSALS.closed);
  const refusals = { ...FORM_PAGE_REFUSALS, ...(row.words?.refusals ?? {}) };
  return { slug, formId: form.formId, title: form.title ?? null, around: row.around, words: row.words ?? {}, keep_on: row.keep_on ?? null, keep_at: row.keep_at ?? null, refusals, questions: questionsOf(form) };
}

// The page a sitting was started on; its row and its form are read together, once.
const pageOfSitting = async (store: Store, sitting: Sitting) => {
  await store.preload([formPageId(sitting.page), questionSequenceId(sitting.formId)]);
  return loadFormPage(store, sitting.page);
};

// Starts a sitting: as the signed-in member when there is one (`email`, proven by the caller), else as the sitting itself.
export async function startSitting(store: Store, { slug, email = null }: { slug: string; email?: string | null }, { now = () => new Date().toISOString(), newId = () => crypto.randomUUID() }: Clock = {}) {
  const page = await loadFormPage(store, slug);
  const id = newId();
  const sitting = { kind: SITTING_KIND, formId: page.formId, respondentId: email ?? `${VISITOR}${id}`, submissionId: id, page: slug, page_kind: FORM_PAGE_KIND, status: 'started', lastStep: null, startedAt: now(), steps: {} };
  await store.apply([{ kind: 'insert', id: sittingId(id), type: SITTING_KIND, value: sitting }]);
  const fresh = { answers: {} };
  return { attemptId: id, next: stepView(page, nextStepOf(page, fresh), fresh), form: definitionOf(page) };
}

// One answer, kept as a booking keeps it (sitting.ts answerQuestion), with this page's words. `questionId` names the question the
// answer is for, so an answer sent twice is kept once and one sent out of order is refused. `answers` is a list of { questionId,
// value } kept one after the other (sitting.ts answerQuestions).
export async function answerFormQuestion(
  store: Store,
  { attemptId, value, questionId, answers }: { attemptId: string; value?: unknown; questionId?: string; answers?: { questionId?: string; value: unknown }[] },
  clock: Clock = {},
) {
  const sitting = await anySittingOf(store, attemptId, FORM_PAGE_REFUSALS);
  const page = await pageOfSitting(store, sitting);
  return answerQuestions(store, { attemptId, value, questionId, answers, now: clock.now }, { pageOf: async () => page, refusals: page.refusals });
}

// The sitting's answers by question id, and the rows its decision is made from.
async function decisionInputOf(store: Store, page: Page, sitting: Sitting) {
  const facts = await store.factsOf(sitting.submissionId);
  const answers = Object.fromEntries(facts.map(fact => [fact.questionId, fact.value]));
  const rows = await store.decisionRows(page.formId, questionSequenceId(page.formId), DECISION_KINDS);
  return { facts, answers, rows };
}

// The decision for the answers so far, made by the form tools: the segment with its words from its rule, and the follow-up.
function resultOf(decided: any, rows: { type: string; value: any }[]) {
  const rule = decided.decision?.segmentId ? rows.find(row => row.type === 'segment-rule' && row.value.segmentId === decided.decision.segmentId)?.value : null;
  return {
    segment: decided.decision?.segmentId ? { id: decided.decision.segmentId, title: rule?.title ?? decided.decision.segmentId, meaning: rule?.meaning ?? null, next_step: rule?.nextStep ?? null } : null,
    follow_up: (decided.follow_up?.steps ?? []).map((step: any) => ({ id: step.stepId, label: step.label ?? step.stepId })),
  };
}

async function decide(store: Store, page: Page & { refusals: Refusals }, sitting: Sitting, respondentId: string, now: () => string) {
  const input = await decisionInputOf(store, page, sitting);
  const decided = await submitFormAnswers({ form_id: page.formId, respondent_id: respondentId, answers: input.answers, rows: input.rows, submission_id: sitting.submissionId, answered_at: now() });
  if (!decided.accepted) throw refusal(page.refusals.not_done, 409);
  return { ...input, decided };
}

// Refuses a started sitting that still has a question to answer.
async function needsEveryAnswer(store: Store, page: Page & { refusals: Refusals }, sitting: Sitting) {
  if (sitting.status !== 'started') return;
  const progress = await progressOf(store, page, sitting);
  if (nextStepOf(page, progress)?.kind === 'question') throw refusal(page.refusals.not_done, 409);
}

// The result step: the sitting has answered every question it was asked. Says whether it is kept yet, and where it is read.
export async function formResult(store: Store, { attemptId }: { attemptId: string }, { now = () => new Date().toISOString() }: Clock = {}) {
  const sitting = await anySittingOf(store, attemptId, FORM_PAGE_REFUSALS);
  const page = await pageOfSitting(store, sitting);
  await needsEveryAnswer(store, page, sitting);
  const { decided, rows } = await decide(store, page, sitting, sitting.respondentId, now);
  return { ...resultOf(decided, rows), kept: !sitting.respondentId.startsWith(VISITOR), keep_at: page.keep_at };
}

// Keeps a sitting under the proven email: its facts move from the sitting to the person, and the decision's rows are written with
// them, in one write; the sitting is marked kept. Keeping it again under the same email answers the same.
export async function keepSitting(store: Store, { attemptId, email }: { attemptId: string; email: string | null }, { now = () => new Date().toISOString() }: Clock = {}) {
  if (typeof email !== 'string' || !email) throw refusal('Sign in to keep your answers.', 401);
  const sitting = await anySittingOf(store, attemptId, FORM_PAGE_REFUSALS);
  const page = await pageOfSitting(store, sitting);
  const visitor = sitting.respondentId.startsWith(VISITOR);
  if (!visitor && sitting.respondentId !== email) throw refusal(page.refusals.someone_else, 403);
  await needsEveryAnswer(store, page, sitting);
  const { decided, rows, facts } = await decide(store, page, sitting, email, now);
  const moved = facts.filter(fact => fact.respondentId !== email);
  const writes: Write[] = [];
  if (moved.length > 0) writes.push({ kind: 'delete_many', ids: moved.map(fact => answerFactId(page.formId, fact.respondentId, fact.questionId, sitting.submissionId)) });
  for (const fact of moved) writes.push({ kind: 'upsert', id: answerFactId(page.formId, email, fact.questionId, sitting.submissionId), type: ANSWER_FACT_KIND, value: { ...fact, respondentId: email } });
  for (const row of decided.keep.filter((record: { type: string }) => record.type !== ANSWER_FACT_KIND)) writes.push({ kind: 'upsert', id: row.id, type: row.type, value: row.value });
  writes.push({ kind: 'merge', id: sittingId(sitting.submissionId), changes: { status: 'kept', respondentId: email, keptAt: now(), lastStep: 'result' } });
  await store.apply(writes);
  return { ...resultOf(decided, rows), kept: true, keep_at: page.keep_at };
}

// What a sitting has reached: a kept one is done; a started one (a visitor's or a member's) answers its next step, so a page opened
// again (or after the sign-in) goes on where it was, the result step included.
export async function sittingNext(store: Store, { attemptId }: { attemptId: string }) {
  const sitting = await anySittingOf(store, attemptId, FORM_PAGE_REFUSALS);
  const page = await pageOfSitting(store, sitting);
  if (sitting.status !== 'started') return { kept: true, next: { key: 'result', kind: 'result' } };
  const progress = await progressOf(store, page, sitting);
  return { kept: false, next: stepView(page, nextStepOf(page, progress), progress), form: definitionOf(page) };
}
