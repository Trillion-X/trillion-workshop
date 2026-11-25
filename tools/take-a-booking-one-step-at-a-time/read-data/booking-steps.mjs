// The one-question-at-a-time path of a booking page: the steps a page asks, the next step a booking is waiting at, the answer
// each step accepts, and the step a booking that was left reached last. A page is data (its questions, in order, and the steps
// around them); this file holds no question text, no product word and no calendar call. Every answer is a value a caller saves
// as its own row.
// The steps around the questions are the page's `around`: { before, after }, each a list of step names. A booking asks the email
// before and a slot and a confirm after (BOOKING_AROUND, the default); a page that asks first and is kept later states
// { before: [], after: ['result'] }. A step is waiting while the progress holds no value under its name (progress.email,
// progress.slot); a step whose name the progress never holds (confirm, result) is where the page stops and draws that step.
// What a question is and how its answer is checked are the form owner's (tools/ask-questions-sort-answers-follow-up): a
// question's type, its options (one pick or several, an other option with the person's own words), its rules and what it is
// about are a question descriptor there, so a booking page asks any question a form can ask and checks it the same way.
import { registry } from '../../ask-questions-sort-answers-follow-up/do-work/check-answers.mjs';
import { validateAnswer, coerceAnswer } from '../../ask-questions-sort-answers-follow-up/read-data/validate-answer.ts';
import { mergeRules } from '../../ask-questions-sort-answers-follow-up/read-data/fill-screen-model.ts';
import { readDescriptor } from '../../ask-questions-sort-answers-follow-up/read-data/read-forms-data.ts';
import { resolveAbout, answerText, isAsked } from '../../ask-questions-sort-answers-follow-up/read-data/question-descriptor.ts';
import { holds } from '../../ask-questions-sort-answers-follow-up/do-work/rule-engine.mjs';

export const EMAIL_STEP = 'email';
export const SLOT_STEP = 'slot';
export const CONFIRM_STEP = 'confirm';
export const questionStep = position => `question:${position}`;
// The steps around a booking's questions: what a page that states no `around` asks.
export const BOOKING_AROUND = Object.freeze({ before: Object.freeze([EMAIL_STEP]), after: Object.freeze([SLOT_STEP, CONFIRM_STEP]) });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_ANSWER = 2000;
// A question that names no type is a written answer of at most MAX_ANSWER characters.
const WRITTEN = { questionTypeId: 'long-text', validation: { max: MAX_ANSWER } };

// The step names a page's `around` states before or after its questions, checked: a list of names, none a question's, none twice.
function aroundOf(page) {
  const around = page.around ?? BOOKING_AROUND;
  if (!around || typeof around !== 'object' || Array.isArray(around)) throw new Error('A page states the steps around its questions as { before, after }.');
  const seen = new Set();
  const named = side => {
    const list = around[side] ?? [];
    if (!Array.isArray(list)) throw new Error(`The steps ${side} the questions are a list of step names.`);
    return list.map(name => {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`A step ${side} the questions is named in lowercase words joined by dashes.`);
      if (seen.has(name)) throw new Error(`The step ${name} is stated more than once.`);
      seen.add(name);
      return { key: name, kind: name };
    });
  };
  return { before: named('before'), after: named('after') };
}

// page: { questions: [{ position, prompt, required?, question? }], around? } in any order; the steps follow position order.
// `question` is the rest of the form owner's question descriptor (questionId, questionTypeId, options, multiple, other, help,
// about...). `around` names the steps before and after the questions (BOOKING_AROUND when it is not stated).
export function stepsOf(page) {
  if (!page || !Array.isArray(page.questions)) throw new Error('A booking page states its questions as an array.');
  const positions = new Set();
  const questions = page.questions.map((question, index) => {
    if (!question || !Number.isInteger(question.position) || question.position < 0) throw new Error(`Question ${index} needs a whole-number position from 0.`);
    if (positions.has(question.position)) throw new Error(`Question position ${question.position} is stated more than once.`);
    positions.add(question.position);
    if (typeof question.prompt !== 'string' || question.prompt.trim() === '') throw new Error(`Question at position ${question.position} needs a prompt.`);
    if (question.required !== undefined && typeof question.required !== 'boolean') throw new Error(`Question at position ${question.position} states required as true or false.`);
    const required = question.required !== false;
    const given = question.question && typeof question.question === 'object' ? question.question : {};
    const descriptor = readDescriptor({ ...WRITTEN, questionId: String(question.position), ...given, label: question.prompt, required, validation: { ...(given.questionTypeId ? {} : WRITTEN.validation), ...(given.validation ?? {}) } });
    if (!registry.has(descriptor.questionTypeId)) throw new Error(`Question at position ${question.position} names the type ${descriptor.questionTypeId}, which is not one of ${[...registry.keys()].join(', ')}.`);
    return { key: questionStep(question.position), kind: 'question', position: question.position, prompt: question.prompt, required, question: descriptor };
  }).sort((a, b) => a.position - b.position);
  const ids = new Set();
  for (const step of questions) {
    if (ids.has(step.question.questionId)) throw new Error(`Question id ${step.question.questionId} is stated more than once.`);
    ids.add(step.question.questionId);
  }
  const { before, after } = aroundOf(page);
  return [...before, ...questions, ...after];
}

function answered(step, answer) {
  if (answer === undefined) return false;
  return !step.required || checkAnswer(step, answer).ok;
}

// The answers so far keyed by question id, as the form owner's rules read them.
function answersById(steps, answers) {
  return Object.fromEntries(steps.filter(step => step.kind === 'question' && answers[step.position] !== undefined).map(step => [step.question.questionId, answers[step.position]]));
}

// A step around the questions holds its value in the progress under its own name (progress.email, progress.slot).
const heldOf = (progress, step) => progress?.[step.key];

// progress: { answers: { [position]: value }, email?, slot?, ... }. An optional question is done once it has an answer, even an
// empty one; a required one once its answer passes its check. A question asked only when its rules hold (the form owner's
// showWhen and hideWhen, read by the formula engine over the answers so far) is passed by while they do not. A step around the
// questions waits until the progress holds its value; one whose value the progress never holds (confirm, result) is where the
// page stops.
export function nextStepOf(page, progress) {
  const steps = stepsOf(page);
  const answers = progress?.answers ?? {};
  const byId = answersById(steps, answers);
  for (const step of steps) {
    if (step.kind === 'question') {
      if (!isAsked(step.question, byId, holds)) continue;
      if (!answered(step, answers[step.position])) return step;
      continue;
    }
    if (!heldOf(progress, step)) return step;
  }
  return null;
}

// A question step as it is asked now: its prompt with what it is about filled in from an earlier answer, and that thing.
export function askedStep(page, step, progress) {
  if (step?.kind !== 'question') return { ...step, about: null };
  const steps = stepsOf(page).filter(item => item.kind === 'question');
  const byId = answersById(steps, progress?.answers ?? {});
  const { label, about } = resolveAbout(step.question, steps.map(item => item.question), byId);
  return { ...step, prompt: label, about };
}

// The step a booking reached last: the latest step it has an answer for, in the page's order. null when nothing is answered yet.
export function lastStepReachedOf(page, progress) {
  const steps = stepsOf(page);
  let reached = null;
  for (const step of steps) {
    if (step.kind === 'question' ? progress?.answers?.[step.position] !== undefined : Boolean(heldOf(progress, step))) reached = step.key;
  }
  return reached;
}

// The answer a step accepts: a written answer trimmed, picks as { picked, other? }, with `text`, the answer in words for a
// person to read. A refusal names the rule, never the value given, so an email is not echoed back.
export function checkAnswer(step, value) {
  if (step.kind === 'email') {
    const email = typeof value === 'string' ? value.trim() : '';
    if (email.length === 0 || email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) return { ok: false, reason: 'An email address is needed, like name@example.com.' };
    return { ok: true, value: email };
  }
  if (step.kind === 'slot') {
    const start = typeof value === 'string' ? value.trim() : '';
    if (!Number.isFinite(Date.parse(start))) return { ok: false, reason: 'A time to book is needed.' };
    return { ok: true, value: new Date(start).toISOString() };
  }
  if (step.kind === 'question') {
    const spec = checkSpecOf(step);
    return checkAgainst(step.question, spec, value);
  }
  throw new Error(`A ${step.kind} step takes no answer here.`);
}

// What a question's answer is checked against, as plain data a browser can hold: how the answer is read (`coerce`), the rules
// (the type's own, the question's bounds and `required`) and the choices it may pick from. The server's check and the page's
// check are this one thing, so a page that passes an answer is not refused by the rules it was given.
export function checkSpecOf(step) {
  const type = registry.get(step.question.questionTypeId);
  return {
    coerce: type.coerce,
    rules: mergeRules(type.validate?.rules, { ...(step.required ? { required: true } : {}), ...(step.question.validation ?? {}) }),
    options: step.question.options,
    multiple: step.question.multiple,
    other: step.question.other,
  };
}

// An answer to a question, checked against its spec: the words the page shows and the value that is kept.
export function checkAgainst(question, spec, value) {
  if (spec.coerce === 'string' && typeof value !== 'string') return { ok: false, reason: 'An answer is written as text.' };
  const given = typeof value === 'string' ? value.trim() : value;
  const verdict = validateAnswer(given, spec.coerce, spec.rules, { options: spec.options, multiple: spec.multiple, other: spec.other });
  if (!verdict.ok) return { ok: false, reason: `${verdict.message}.` };
  const coerced = coerceAnswer(given, spec.coerce).value;
  const kept = coerced === undefined ? '' : coerced;
  return { ok: true, value: kept, text: answerText(question, kept) };
}
