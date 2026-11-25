// tools/take-a-booking-one-step-at-a-time/steps/serve-booking.ts
//
// PURPOSE
//   The main of the tools that take one step of a booking page (booking-steps.ts): start, answer, times, choose, ready, keep. A tool's
//   row names its step in argv (`node serve-booking.ts start`). The calendar's busy times and the made event are inputs the caller
//   brings from the calendar tools; nothing here reads a key or calls a calendar.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each step takes the named input only; nothing here reads a row or names a table.
//   2. The busy times reach only the steps that work out open times.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveSteps, type Step } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';
import { answerBookingQuestion, checkBookingReady, chooseSlot, keepBooking, readOpenTimes, startBooking } from './booking-steps.ts';

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const BOOKING_STEPS: Record<string, Step> = {
  start: (store, input) => startBooking(store, { slug: text(input.page), email: input.email }),
  answer: (store, input) => answerBookingQuestion(store, { attemptId: text(input.attemptId), value: input.value, questionId: text(input.questionId) || undefined, answers: Array.isArray(input.answers) ? input.answers : undefined }),
  times: (store, input) => readOpenTimes(store, { attemptId: text(input.attemptId), busy_read: input.busy_read }),
  choose: (store, input) => chooseSlot(store, { attemptId: text(input.attemptId), value: input.value, busy_read: input.busy_read }),
  ready: (store, input) => checkBookingReady(store, { attemptId: text(input.attemptId), busy_read: input.busy_read }),
  keep: (store, input) => keepBooking(store, { attemptId: text(input.attemptId), event: input.event ?? null, source: input.source }),
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveSteps(BOOKING_STEPS);
