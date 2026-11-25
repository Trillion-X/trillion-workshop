// tools/ask-questions-sort-answers-follow-up/show/optimistic-run.ts
//
// PURPOSE
//   One run of a form on a page that does not wait on the network between questions. The page holds the whole form (`Definition`:
//   each question as it is first drawn, how its answer is checked, and whether it needs the server) and this module does the rest:
//   it checks each answer where the visitor is, names the next question at once, and sends the answers to the step tool in the
//   background, one queue, in order, trying again when the network fails. When the step tool refuses an answer the page had
//   passed, the queue stops, the later answers stay with the page, and the page is told which question to go back to and why.
//   A step that needs the server's fact (the question after a conditional one, the last question) is waited for with `settled`.
//   The drawing is the screen's; nothing here reads the window, the DOM or the clock but through what the screen hands in.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An answer the page passes is checked by the rules the step tool gave (the tool's own spec), so the tool does not refuse
//      what the page passed unless the world changed (a closed page, a rule edited since).
//   2. The queue sends one answer at a time, in the order they were passed, each naming its question; an answer is never sent
//      while an earlier one is not kept. A refused answer ends the queue: later answers are not sent until the visitor sends them
//      again, so none is kept for a question the tool did not reach.
//   3. A network failure (`Retry`) is tried again, `tries` times with a growing wait; after that the queue waits (`Stalled`) and
//      the next answer, or `resume()`, starts it again. A failure that is not the network is a refusal and is never repeated.
//   4. The page moves ahead alone only to a question that does not depend on an answer: a question with a rule about earlier
//      answers or wording drawn from one is never named here, because those rules run on the server; the page waits for it.
//   5. What is not yet kept (`unsent`) is what the page sends, in order, when it is closed.
//   6. Answers the page holds (`held`) are kept across a refusal, so the visitor corrects one answer and loses no other.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { coerceAnswer, validateAnswer, type AnswerValidationRules, type ChoiceShape, type CoerceKind } from '../read-data/validate-answer.ts';
import type { Next } from './FormSteps.tsx';

/** How a question's answer is checked: the step tool's own spec for it (booking-steps.mjs checkSpecOf). */
export type Check = ChoiceShape & { coerce: CoerceKind; rules: AnswerValidationRules };
export type DefinedQuestion = { next: Next; check: Check; conditional: boolean };
export type Definition = { questions: DefinedQuestion[] };
/** One answer on its way to the step tool. */
export type Item = { questionId: string; value: unknown };
/** What the step tool answers to one answer: the step that is next (null when nothing is). */
export type Sent = { next: Next | null };

/** Thrown by `send` for a failure of the network or the place that answers (try again); anything else it throws is a refusal. */
export class Retry extends Error {}
/** A refusal of an answer by the step tool: where it was and its words. */
export class Refused extends Error {
  position: number;
  questionId: string;
  constructor(message: string, position: number, questionId: string) {
    super(message);
    this.position = position;
    this.questionId = questionId;
  }
}
/** The queue gave up for now after `tries` network failures; the answers are still held. */
export class Stalled extends Error {}

export type Verdict = { ok: true; value: unknown } | { ok: false; message: string };
export type Answered =
  /** The answer is wrong by the rules; nothing is sent. */
  | { kind: 'invalid'; message: string }
  /** The next question is known without the server: show it now. `held` is the answer already held for it, if any. */
  | { kind: 'advance'; next: Next; held: unknown }
  /** The next step needs the server's fact: show it as pending until `settled` answers. */
  | { kind: 'wait'; settled: Promise<Sent> };

export type RunOptions = {
  definition: Definition;
  /** Sends answers to the step tool, in this order; throws `Retry` for the network and any other Error for a refusal. */
  send: (items: Item[]) => Promise<Sent>;
  /** Called once when the step tool refuses an answer: go back to that question with these words. */
  onRefused?: (refused: Refused) => void;
  tries?: number;
  /** Waits this long (ms) before another try; the screen's own clock, so a test can pass an instant one. */
  wait?: (ms: number) => Promise<void>;
  backoffMs?: number;
};

export function createRun({ definition, send, onRefused, tries = 5, wait = ms => new Promise(done => setTimeout(done, ms)), backoffMs = 400 }: RunOptions) {
  const { questions } = definition;
  const placeOf = (questionId: string) => questions.findIndex(question => question.next.question?.questionId === questionId);
  const held = new Map<string, unknown>();
  const queue: Item[] = [];
  let last: Sent | null = null;
  let failure: Error | null = null;
  let running: Promise<void> | null = null;
  let waiting: { resolve: (sent: Sent) => void; reject: (why: Error) => void }[] = [];

  const settle = () => {
    const done = waiting;
    waiting = [];
    for (const waiter of done) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(last ?? { next: null });
    }
  };

  async function sendWithRetries(item: Item): Promise<Sent> {
    for (let attempt = 1; ; attempt += 1) {
      try { return await send([item]); } catch (caught) {
        if (!(caught instanceof Retry)) throw caught;
        if (attempt >= tries) throw new Stalled(caught.message);
        await wait(backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  async function pump() {
    failure = null;
    while (queue.length > 0) {
      const item = queue[0]!;
      try {
        last = await sendWithRetries(item);
        queue.shift();
      } catch (caught) {
        if (caught instanceof Stalled) { failure = caught; break; }
        // Refused: the later answers stay held, none of them is sent.
        queue.length = 0;
        failure = new Refused(caught instanceof Error ? caught.message : '', placeOf(item.questionId), item.questionId);
        onRefused?.(failure as Refused);
        break;
      }
    }
    running = null;
    settle();
  }

  const start = () => { running ??= pump(); };

  /** An answer checked by the rules the page holds; the value is the one the step tool keeps. */
  function check(position: number, value: unknown): Verdict {
    const question = questions[position];
    if (!question) return { ok: false, message: '' };
    const { coerce, rules, options, multiple, other } = question.check;
    if (coerce === 'string' && typeof value !== 'string') return { ok: false, message: 'An answer is written as text.' };
    const given = typeof value === 'string' ? value.trim() : value;
    const verdict = validateAnswer(given, coerce, rules, { options, multiple, other });
    if (!verdict.ok) return { ok: false, message: `${verdict.message}.` };
    const coerced = coerceAnswer(given, coerce).value;
    return { ok: true, value: coerced === undefined ? '' : coerced };
  }

  /** The question after this one when no server is needed to name it, else null. */
  function followingOf(position: number): DefinedQuestion | null {
    const next = questions[position + 1];
    return next && !next.conditional ? next : null;
  }

  const run = {
    check,
    /** Where a question is in the definition (the place `answer` takes), or -1. */
    placeOf,
    /** The answer the visitor gave to a question, kept across a refusal. */
    held: (questionId: string): unknown => held.get(questionId),
    /** Answers not yet kept, the one being sent first (it leaves the queue only once kept): what the page sends when it is closed. */
    unsent: (): Item[] => [...queue],
    stalled: () => failure instanceof Stalled,
    /** Starts a stalled queue again. */
    resume: () => { if (queue.length > 0) start(); },
    /** Resolves when every answer passed so far is kept (with the step tool's last answer); rejects with the refusal or the stall. */
    settled: (): Promise<Sent> => {
      if (queue.length === 0 && !running) return failure ? Promise.reject(failure) : Promise.resolve(last ?? { next: null });
      return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); });
    },
    /** A visitor's answer to the question at `position`. */
    answer(position: number, value: unknown): Answered {
      const verdict = check(position, value);
      if (!verdict.ok) return { kind: 'invalid', message: verdict.message };
      const questionId = questions[position]!.next.question!.questionId;
      held.set(questionId, value);
      queue.push({ questionId, value });
      start();
      const following = followingOf(position);
      if (following) return { kind: 'advance', next: following.next, held: held.get(following.next.question!.questionId) ?? null };
      return { kind: 'wait', settled: run.settled() };
    },
  };
  return run;
}

export type Run = ReturnType<typeof createRun>;

/** The body a page being closed sends in one call (the step tool's `answers`), or null when nothing is unsent. */
export const closingBody = (attemptId: string, items: Item[]) => (items.length === 0 ? null : JSON.stringify({ attemptId, answers: items }));
