// tools/ask-questions-sort-answers-follow-up/show/FormPageScreen.tsx
//
// PURPOSE
//   The screen of tool:read-a-form-page: a form asked one question at a time that drives itself. A page row places it with
//   plain JSON props (the page's address name, its words, its question count and the site that keeps the answers) and it holds
//   the sitting: it asks the site's form routes what comes next, sends each answer as it is made, shows the result and keeps
//   it under the visitor's email through the site's sign-in. The drawing is show/FormPage.tsx's.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Rendering is pure: nothing is fetched, stored or read from the window while it renders (the server draws the intro).
//      Every call to the site's routes and every use of this browser's storage happens after it is mounted, in an effect or
//      a press.
//   2. The routes are `<api_base>/form.start|answer|next|result|keep`, each answering JSON, and a refusal carries its own
//      words as `error`; a database or network failure shows the page's `words.failed`, never its own text.
//   3. The sitting's id is kept in this browser under a key made from the page name, so a page opened again goes on where it
//      was; a sitting that is already kept is let go of.
//   4. Props are plain JSON: `page`, `title`, `words`, `questions`, `keep_on`, `signed_in`, `api_base`.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React, { useEffect, useRef, useState } from 'react';
import { View as FormPage, type PageInfo, type Result, type Screen } from './FormPage.tsx';
import type { Answer, Next } from './FormSteps.tsx';

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

async function call<T>(base: string, step: string, failed: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/${step}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof answer.error === 'string' ? answer.error : failed);
  return answer as T;
}

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
  const goTo = async (next: Next | null) => {
    setAnswer(null);
    if (next?.kind === 'question') setScreen({ kind: 'question', next });
    else await showResult();
  };

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
    const started = await call<{ attemptId: string; next: Next }>(api_base, 'form.start', failed, { page });
    attempt.current = started.attemptId;
    localStorage.setItem(sittingKey, started.attemptId);
    await goTo(started.next);
  });
  const resume = () => run(async () => {
    const where = await call<{ next: Next | null }>(api_base, 'form.next', failed, { attemptId: attempt.current });
    await goTo(where.next);
  });
  const send = (given: Answer) => run(async () => {
    const sent = await call<{ next: Next | null }>(api_base, 'form.answer', failed, { attemptId: attempt.current, value: given ?? '' });
    await goTo(sent.next);
  });
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
      onSend={given => void send(given)}
      onEmailChange={setEmail}
      onKeep={keep}
    />
  );
}
