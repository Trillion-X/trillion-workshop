// tools/ask-questions-sort-answers-follow-up/show/use-optimistic-form.ts
//
// PURPOSE
//   What a screen that asks a form question by question does so that it never waits on the network between questions, for the
//   form page and the booking page alike: it holds the form the step tool handed over at start (show/optimistic-run.ts), moves to
//   the next question at once, goes back to a question the step tool refused (with its words and every answer given), waits inside
//   the button only for a step that needs the server's fact, and sends the answers not yet kept in one call when the page is closed.
//   The screen keeps its own drawing and its own state; it passes the few things this needs to do to them as `ui`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is fetched while rendering: the calls are made from a press, and the page-closing listeners are added in an effect.
//   2. The route that takes an answer is the screen's own (`answerStep`, e.g. `form.answer`); it takes one answer with the question
//      it is for, and the list of answers (`answers`) a closing page still holds.
//   3. A refusal never repeats a question's wording from memory: the question is drawn as it was last drawn (the server may have
//      worded it from an earlier answer), else as the form first drew it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { useEffect, useRef } from 'react';
import type { Answer, Asked, Next } from './FormSteps.tsx';
import { callStep } from './call-step.ts';
import { closingBody, createRun, Refused, type Definition, type Item, type Run, type Sent } from './optimistic-run.ts';

export type OptimisticUi = {
  /** Draw this question, with the answer already held for it (or none). */
  show: (next: Next, held: Answer | null) => void;
  setError: (message: string) => void;
  /** The button of the step that waits for the server shows its loading mark while this is true. */
  setSending: (sending: boolean) => void;
  /** The server's fact is known and the step after it is not a question the page holds (the result, the times): go there. */
  after: (next: Next | null) => Promise<void>;
};

export function useOptimisticForm({ api_base, answerStep, failed, attempt, ui }: { api_base: string; answerStep: string; failed: string; attempt: { current: string }; ui: OptimisticUi }) {
  const optimistic = useRef<Run | null>(null);
  const definition = useRef<Definition | null>(null);
  // Each question as it was drawn last, by id.
  const shown = useRef(new Map<string, Next>());
  const live = useRef(ui);
  live.current = ui;

  const show = (next: Next) => {
    if (next.question) shown.current.set(next.question.questionId, next);
    live.current.show(next, ((next.question ? optimistic.current?.held(next.question.questionId) : null) as Answer | undefined) ?? null);
  };
  // The step tool refused an answer the page had passed: back to its question, with its words; the answers given are kept.
  const goBack = (refused: Refused) => {
    const next = shown.current.get(refused.questionId) ?? definition.current?.questions[refused.position]?.next;
    if (!next) return;
    show(next);
    live.current.setError(refused.message);
    live.current.setSending(false);
  };
  /** Holds the form the step tool handed over; call it when a sitting starts or is taken up again. */
  const begin = (form: Definition) => {
    definition.current = form;
    shown.current.clear();
    optimistic.current = createRun({
      definition: form,
      onRefused: goBack,
      send: (items: Item[]) => callStep<Sent>(api_base, answerStep, failed, { attemptId: attempt.current, questionId: items[0]!.questionId, value: items[0]!.value }),
    });
  };
  /** Draws a question the step tool named, or goes on to the step after the questions. */
  const goTo = async (next: Next | null) => {
    if (next?.kind === 'question' && next.question) show(next);
    else await live.current.after(next);
  };
  const waitFor = async (settled: Promise<Sent>) => {
    live.current.setSending(true);
    try { await goTo((await settled).next); } catch (caught) {
      // A refusal has already taken the visitor back (goBack); any other failure is told in words.
      if (!(caught instanceof Refused)) live.current.setError(caught instanceof Error && caught.message ? caught.message : failed);
    } finally { live.current.setSending(false); }
  };
  /** The visitor's answer to the question drawn now. */
  const send = (current: Asked | undefined, given: Answer) => {
    const asked = optimistic.current;
    if (!current || !asked) return;
    live.current.setError('');
    const answered = asked.answer(asked.placeOf(current.questionId), given ?? '');
    if (answered.kind === 'invalid') live.current.setError(answered.message);
    else if (answered.kind === 'advance') show(answered.next);
    else void waitFor(answered.settled);
  };
  // What a page being closed sends: the answers not yet kept, in order, in one call (a beacon, else a keepalive fetch).
  const leave = () => {
    const body = closingBody(attempt.current, optimistic.current?.unsent() ?? []);
    if (!body) return;
    const url = `${api_base}/${answerStep}`;
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return;
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  };
  const leaving = useRef(leave);
  leaving.current = leave;
  useEffect(() => {
    const closing = () => leaving.current();
    const hidden = () => { if (document.visibilityState === 'hidden') closing(); };
    window.addEventListener('pagehide', closing);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', closing); document.removeEventListener('visibilitychange', hidden); };
  }, []);

  return { begin, goTo, send, show };
}
