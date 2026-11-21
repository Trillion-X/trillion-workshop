// The one-question-at-a-time path of a booking page: the steps a page asks, the next step a booking is waiting at, the answer
// each step accepts, and the step a booking that was left reached last. A page is data (its questions, in order); this file
// holds no question text, no product word and no calendar call. Every answer is a value a caller saves as its own row.

export const EMAIL_STEP = 'email';
export const SLOT_STEP = 'slot';
export const CONFIRM_STEP = 'confirm';
export const questionStep = position => `question:${position}`;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_ANSWER = 2000;

// page: { questions: [{ position, prompt, required? }] } in any order; the steps follow position order.
export function stepsOf(page) {
  if (!page || !Array.isArray(page.questions)) throw new Error('A booking page states its questions as an array.');
  const positions = new Set();
  const questions = page.questions.map((question, index) => {
    if (!question || !Number.isInteger(question.position) || question.position < 0) throw new Error(`Question ${index} needs a whole-number position from 0.`);
    if (positions.has(question.position)) throw new Error(`Question position ${question.position} is stated more than once.`);
    positions.add(question.position);
    if (typeof question.prompt !== 'string' || question.prompt.trim() === '') throw new Error(`Question at position ${question.position} needs a prompt.`);
    if (question.required !== undefined && typeof question.required !== 'boolean') throw new Error(`Question at position ${question.position} states required as true or false.`);
    return { key: questionStep(question.position), kind: 'text', position: question.position, prompt: question.prompt, required: question.required !== false };
  }).sort((a, b) => a.position - b.position);
  return [{ key: EMAIL_STEP, kind: 'email' }, ...questions, { key: SLOT_STEP, kind: 'slot' }, { key: CONFIRM_STEP, kind: 'confirm' }];
}

// progress: { email: string | null, answers: { [position]: string }, slot: string | null }. An optional question is done once it has an answer, even an empty one.
export function nextStepOf(page, progress) {
  const steps = stepsOf(page);
  const answers = progress?.answers ?? {};
  for (const step of steps) {
    if (step.key === EMAIL_STEP && !progress?.email) return step;
    if (step.kind === 'text') {
      const answer = answers[step.position];
      if (answer === undefined || (step.required && answer.trim() === '')) return step;
    }
    if (step.key === SLOT_STEP && !progress?.slot) return step;
    if (step.key === CONFIRM_STEP) return step;
  }
  return null;
}

// The step a booking reached last: the latest step it has an answer for, in the page's order. null when nothing is answered yet.
export function lastStepReachedOf(page, progress) {
  const steps = stepsOf(page);
  let reached = null;
  for (const step of steps) {
    if (step.key === EMAIL_STEP && progress?.email) reached = step.key;
    if (step.kind === 'text' && progress?.answers?.[step.position] !== undefined) reached = step.key;
    if (step.key === SLOT_STEP && progress?.slot) reached = step.key;
  }
  return reached;
}

// The answer a step accepts, trimmed. A refusal names the rule, never the value given, so an email is not echoed back.
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
  if (step.kind === 'text') {
    if (typeof value !== 'string') return { ok: false, reason: 'An answer is written as text.' };
    const answer = value.trim();
    if (step.required && answer === '') return { ok: false, reason: 'This question needs an answer.' };
    if (answer.length > MAX_ANSWER) return { ok: false, reason: `An answer is at most ${MAX_ANSWER} characters.` };
    return { ok: true, value: answer };
  }
  throw new Error(`A ${step.kind} step takes no answer here.`);
}
