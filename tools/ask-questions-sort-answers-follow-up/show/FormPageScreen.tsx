// tools/ask-questions-sort-answers-follow-up/show/FormPageScreen.tsx
//
// PURPOSE
//   The screen of tool:read-a-form-page: a form asked one question at a time that drives itself. A page row places it with
//   plain JSON props (the page's address name, its words, its question count and the site that keeps the answers) and it holds
//   the sitting: it asks the site's form routes what comes next, shows the result and keeps it under the visitor's email through
//   the site's sign-in. It does not wait on the network between questions: the form's start hands over the whole form (each
//   question, how its answer is checked, whether it needs the server) and show/optimistic-run.ts checks each answer here, names the
//   next question at once and sends the answers in the background, in order. The drawing is show/FormPage.tsx's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rendering is pure: nothing is fetched, stored or read from the window while it renders (the server draws the intro).
//      Every call to the site's routes and every use of this browser's storage happens after it is mounted, in an effect or
//      a press.
//   2. The routes are `<api_base>/form.start|answer|next|result|keep`, each answering JSON (`form.answer` takes one answer with the
//      question it is for, or the list of answers a closing page still holds), and a refusal carries its own
//      words as `error`, and when the step tool refused in its own words `why` too: the error line shows `why` when it is there and
//      `error` when it is not; a database or network failure shows the page's `words.failed`, never its own text.
//   3. The sitting's id is kept in this browser under a key made from the page name, so a page opened again goes on where it
//      was; a sitting that is already kept is let go of.
//   4. Props are plain JSON: `page`, `title`, `words`, `questions`, `keep_on`, `signed_in`, `api_base`.
//   5. Only a step that needs the server's fact waits: the question after one that depends on earlier answers, and the result. It
//      waits inside the Next button (its loading mark), the question still drawn. An answer the step tool refuses takes the visitor
//      back to its question with the tool's words, every answer given kept; leaving the page sends the answers not yet kept in
//      one call (a beacon, else a keepalive fetch).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useEffect, useRef, useState } from 'react';
import { View as FormPage, type PageInfo, type Result, type Screen } from './FormPage.tsx';
import type { Answer, Next } from './FormSteps.tsx';
import { callStep as call } from './call-step.ts';
import type { Definition } from './optimistic-run.ts';
import { useOptimisticForm } from './use-optimistic-form.ts';

export type FormPageScreenProps = {
  /** The form page's name: its address names its row (`form-page:<page>`). */
  page: string;
  title?: string | null;
  words: Record<string, string | undefined>;
  questions: number;
  /** The site whose sign-in keeps a visitor's answers. */
  keep_on?: string | null;
  signed_in?: boolean;
  api_base?: string;
};

export function View({ page, title = null, words, questions, keep_on = null, signed_in = false, api_base = '/target' }: FormPageScreenProps) {
  const failed = words.failed ?? '';
  const info: PageInfo = { title, words, questions, keep_on, signed_in };
  const sittingKey = `form-page:${page}:sitting`;
  const [screen, setScreen] = useState<Screen>({ kind: 'intro', resumable: false });
  const [answer, setAnswer] = useState<Answer>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const attempt = useRef('');

  const run = async (work: () => Promise<void>) => {
    setError('');
    setSending(true);
    try { await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : failed); } finally { setSending(false); }
  };
  const showResult = async () => {
    const result = await call<Result>(api_base, signed_in ? 'form.keep' : 'form.result', failed, { attemptId: attempt.current });
    if (result.kept) localStorage.removeItem(sittingKey);
    setScreen({ kind: 'result', result });
  };
  // The questions are asked without waiting on the network (show/use-optimistic-form.ts); the result waits for the server's fact.
  const asking = useOptimisticForm({
    api_base,
    answerStep: 'form.answer',
    failed,
    attempt,
    ui: {
      show: (next, held) => { setAnswer(held); setScreen({ kind: 'question', next }); },
      setError,
      setSending,
      after: () => showResult(),
    },
  });

  useEffect(() => {
    void (async () => {
      const keep = new URLSearchParams(window.location.search).get('keep');
      if (keep) {
        attempt.current = keep;
        try {
          const result = await call<Result>(api_base, 'form.keep', failed, { attemptId: keep });
          localStorage.removeItem(sittingKey);
          window.history.replaceState(null, '', window.location.pathname);
          setScreen({ kind: 'result', result });
          return;
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : failed);
        }
      }
      attempt.current = localStorage.getItem(sittingKey) ?? '';
      if (!attempt.current) return;
      try {
        const where = await call<{ kept: boolean }>(api_base, 'form.next', failed, { attemptId: attempt.current });
        if (where.kept) throw new Error('kept');
        setScreen({ kind: 'intro', resumable: true });
      } catch {
        localStorage.removeItem(sittingKey);
        attempt.current = '';
      }
    })();
  }, [api_base, sittingKey, failed]);

  const start = () => run(async () => {
    const started = await call<{ attemptId: string; next: Next; form?: Definition }>(api_base, 'form.start', failed, { page });
    attempt.current = started.attemptId;
    localStorage.setItem(sittingKey, started.attemptId);
    asking.begin(started.form);
    await asking.goTo(started.next);
  });
  const resume = () => run(async () => {
    const where = await call<{ next: Next | null; form?: Definition }>(api_base, 'form.next', failed, { attemptId: attempt.current });
    asking.begin(where.form);
    await asking.goTo(where.next);
  });
  const send = (given: Answer) => {
    if (!sending && screen.kind === 'question') asking.send(screen.next.question, given);
  };
  // The answers are kept on the site the row names: its sign-in proves the email, then sends the person back here with the sitting.
  const keep = (given: string) => {
    const back = `${window.location.pathname}?keep=${encodeURIComponent(attempt.current)}`;
    window.location.assign(`${keep_on ?? ''}/sign-in?${new URLSearchParams({ email: given, next: back })}`);
  };

  return (
    <FormPage
      screen={screen}
      info={info}
      answer={answer}
      email={email}
      error={error}
      sending={sending}
      onStart={() => void start()}
      onResume={() => void resume()}
      onChange={setAnswer}
      onSend={send}
      onEmailChange={setEmail}
      onKeep={keep}
    />
  );
}
