// tools/ask-questions-sort-answers-follow-up/steps/serve-form-page.ts
//
// PURPOSE
//   The main of the five tools that take one step of a form page (form-page-steps.ts): start, answer, next, result, keep. A tool's
//   row names its step in argv (`node serve-form-page.ts start`). The person (the signed-in member's proven email) is named by the
//   trusted caller as `person`; a browser's or an AI's arguments never choose it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each step takes the named input only and passes it on as text; nothing here reads a row or names a table.
//   2. `person` reaches only the steps that start or keep a sitting as someone.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { answerFormQuestion, formResult, keepSitting, sittingNext, startSitting } from './form-page-steps.ts';
import { serveSteps, type Step } from './serve-steps.ts';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const personOf = (input: { person?: unknown }) => (typeof input.person === 'string' && input.person !== '' ? input.person : null);

export const FORM_PAGE_STEPS: Record<string, Step> = {
  start: (store, input) => startSitting(store, { slug: text(input.page), email: personOf(input) }),
  answer: (store, input) => answerFormQuestion(store, { attemptId: text(input.attemptId), value: input.value }),
  next: (store, input) => sittingNext(store, { attemptId: text(input.attemptId) }),
  result: (store, input) => formResult(store, { attemptId: text(input.attemptId) }),
  keep: (store, input) => keepSitting(store, { attemptId: text(input.attemptId), email: personOf(input) }),
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveSteps(FORM_PAGE_STEPS);
