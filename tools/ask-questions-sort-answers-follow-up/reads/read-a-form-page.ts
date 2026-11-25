// tools/ask-questions-sort-answers-follow-up/reads/read-a-form-page.ts
//
// PURPOSE
//   Reads one form page of a pursuit: the page row's title and words, how many questions its form asks, and the site that
//   keeps a visitor's answers. The answer is the props of show/FormPageScreen.tsx, so a page and an AI app's screen get the
//   same answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a live page whose form has questions is answered; a page that is not live, is unknown or names no kept form is
//      refused in the words the page row gives (`words.refusals.closed`), else the plain default below.
//   2. The row and column names are the one block below; nothing else here names a table.
//   3. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one place the table and the id prefixes are named.
const SOURCE = { table: 'form_rows', page_prefix: 'form-page:', sequence_prefix: 'question-sequence:' } as const;
const CLOSED = 'This page is not open.';

export type FormPageAnswer = { page: string; title: string | null; words: Record<string, string>; questions: number; keep_on: string | null };
type Given = { database: string; page: string };

const refusal = (value: Record<string, unknown> | undefined): string => {
  const words = value?.words as { refusals?: { closed?: unknown } } | undefined;
  return typeof words?.refusals?.closed === 'string' ? words.refusals.closed : CLOSED;
};

export const readFormPage: Reader<Given, FormPageAnswer> = async (input, rows) => {
  if (typeof input.page !== 'string' || input.page === '') throw new Error('Give page: the form page\'s name.');
  const found = await rows(`select value from ${SOURCE.table} where id = $1`, [`${SOURCE.page_prefix}${input.page}`]);
  const value = found[0]?.value as Record<string, unknown> | undefined;
  if (!value || value.live !== true || typeof value.formId !== 'string') throw new Error(refusal(value));
  const form = await rows(`select value from ${SOURCE.table} where id = $1`, [`${SOURCE.sequence_prefix}${value.formId}`]);
  const questions = (form[0]?.value as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error(refusal(value));
  const words: Record<string, string> = {};
  for (const [key, word] of Object.entries((value.words ?? {}) as Record<string, unknown>)) if (typeof word === 'string') words[key] = word;
  return {
    page: input.page,
    title: typeof value.title === 'string' ? value.title : typeof (form[0]?.value as { title?: unknown } | undefined)?.title === 'string' ? (form[0].value as { title: string }).title : null,
    words,
    questions: questions.length,
    keep_on: typeof value.keep_on === 'string' ? value.keep_on : null,
  };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readFormPage });
