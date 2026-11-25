// tools/take-a-booking-one-step-at-a-time/reads/read-a-booking-page.ts
//
// PURPOSE
//   Reads one live booking page of a pursuit: its title, time zone, length of a session, the windows it offers and how far
//   ahead, and the questions its form asks, in the form's order. The answer is the props of show/BookingPage.tsx, so a page and
//   an AI app's screen get the same answer. The calendar is not read here: the open times are the booking routes' (book.slots).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a live page that has windows to offer and a kept form with questions is answered; any other page is refused by name.
//   2. A question's place is its position in the form; its prompt is the form's label; it is required unless the form says not.
//   3. The table and column names are the one block below; nothing else here names a table.
//   4. Nothing here holds a login or a client: the reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

// The one place the tables, columns and id prefix are named.
const SOURCE = {
  pages: { table: 'booking_pages', columns: 'slug, title, duration_minutes, timezone, windows, horizon_days, min_notice_minutes, form_id' },
  forms: { table: 'form_rows', sequence_prefix: 'question-sequence:' },
} as const;

export type BookingQuestion = { position: number; prompt: string; required: boolean };
export type BookingPageAnswer = {
  page: string; title: string; timezone: string; duration_minutes: number; horizon_days: number; min_notice_minutes: number;
  windows: unknown[]; questions: BookingQuestion[];
};
type Given = { database: string; page: string };

export const readBookingPage: Reader<Given, BookingPageAnswer> = async (input, rows) => {
  if (typeof input.page !== 'string' || input.page === '') throw new Error('Give page: the booking page\'s name.');
  const found = await rows(`select ${SOURCE.pages.columns} from ${SOURCE.pages.table} where slug = $1 and live`, [input.page]);
  const page = found[0];
  if (!page) throw new Error('This booking page is not open.');
  if (!Array.isArray(page.windows) || page.windows.length === 0) throw new Error('This booking page has no times to offer yet.');
  const forms = await rows(`select value from ${SOURCE.forms.table} where id = $1`, [`${SOURCE.forms.sequence_prefix}${String(page.form_id ?? '')}`]);
  const asked = (forms[0]?.value as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(asked) || asked.length === 0) throw new Error('This booking page has no questions yet.');
  const questions = asked.map((item, position): BookingQuestion => {
    const { label, required } = item as { label?: unknown; required?: unknown };
    return { position, prompt: typeof label === 'string' ? label : '', required: required !== false };
  });
  return {
    page: String(page.slug), title: String(page.title ?? ''), timezone: String(page.timezone ?? ''), duration_minutes: Number(page.duration_minutes),
    horizon_days: Number(page.horizon_days ?? 0), min_notice_minutes: Number(page.min_notice_minutes ?? 0), windows: page.windows, questions,
  };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ readBookingPage });
