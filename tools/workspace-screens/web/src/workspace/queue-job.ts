// src/workspace/queue-job.ts
//
// PURPOSE
//   The workspace's one way to ask the person's own AIs for a job with a button (src/queued-work.mjs on the Worker):
//   the shared QueueJobButton's props for one job row of src/queued-work.json, each press sent to /work/api/queue and
//   answered with the row's words. A screen names the job and its context; it never writes the words or the road.
//   Who took the job and what came back arrive as the person's notifications (person-notifications.ts), on every plan.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Labels and sent words come from src/queued-work.json, the same rows the Worker keeps the job with.
//   2. A refusal (a job no longer offered) is shown in the Worker's own words.
//   3. Every press goes through sendQueuedJob.
//   4. Every press carries what the person did on the page just before it (parts/ui/show/recent-steps), read once at
//      the press, so the AI sees the path that led to the request.

import type { QueueJobButtonProps, QueueJobPress } from '../../parts/ui/show/queue-job/QueueJobButton';
import { notify } from '../../parts/ui/show/coss/notifications';
import { recentSteps } from '../../parts/ui/show/recent-steps';
import { postJson } from './api';
import { followWork } from './person-notifications';
import queued from '../queued-work.json';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
/** Sends one press to the person's store; resolves with its answer. */
export function sendQueuedJob(press: QueueJobPress): Promise<{ asked_id: string; said: string }> {
  return postJson<{ asked_id: string; said: string }>('/work/api/queue', { ...press, steps: recentSteps() });
}

/** The label a job row gives its button, or null when no row offers that job. */
export const queuedJobLabel = (jobId: string): string | null => queued.jobs.find(row => row.id === jobId)?.label ?? null;

/** The words said once a job was sent. */
export const queuedJobDone = queued.words.done;

/** The button's props for one job about one thing, or null when no row offers that job. */
export function queueJobProps(jobId: string, context: Record<string, string>): QueueJobButtonProps | null {
  const label = queuedJobLabel(jobId);
  if (!label) return null;
  return {
    label, sentLabel: queued.words.sent, job: jobId, context, send: sendQueuedJob,
    onSent: answer => notify((answer as { said?: string } | null)?.said || queued.words.done, { kind: 'done' }),
    onFailed: error => notify(errorWords(error), { kind: 'error' }),
    // The button shows the loading mark until the person's notifications say the work this press asked for is done.
    follow: (answer, done) => {
      const about = (answer as { asked_id?: string } | null)?.asked_id;
      return about ? followWork(about, done) : (done(), () => {});
    },
  };
}
