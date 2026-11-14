// src/workspace/ask-my-ai.ts
//
// PORTED FROM: src/workspace/queue-job.ts (its sendQueuedJob road, which every "Ask my AI" button already used; this
// adds waiting for what the AI sends back, read from GET /work/api/job-run the way job-run.tsx reads one job).
//
// PURPOSE
//   Ask my AI: the one way a screen asks the person's own AI for something and gets the answer back into the screen.
//   Trillion runs no model, holds no AI key and asks no local model: a request is a job row of src/queued-work.json
//   handed to whichever of the person's connected AIs their rules pick (sendQueuedJob), and the answer is what that AI
//   sends back with finish_work. Write's Ask AI and the board's Ask my AI both come through here:
//     - `askMyAI(press)` hands the job and resolves with the AI's answer ({ text, items }) once it finishes, or fails
//       with the words of what stands in its way;
//     - `askMyAI(press, { wait: false })` only hands it (the board: its AI puts what it makes into the space itself);
//     - any screen's blind dispatch whose definition id is `ask-my-ai:<job id>` is answered here (answerTarget), with
//       its input's `context` and `request_id`, so a screen asks by DATA (parts/documents shortcut:ask-ai).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every request goes through sendQueuedJob, so no AI connected yet opens the step that connects one first.
//   2. The answer is only what the person's AI sent back: the job's own result (its `show` cards' text, else its text),
//      else its summary. Nothing here writes words for the AI.
//   3. The wait reads the job again whenever the person's store changes (store-changes.ts), never on a timer, and ends
//      when every part of the job is finished, when something stands in its way, or when the caller stops it.
//   4. Words are DATA (ask-my-ai.json); nothing here names a screen or a job.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { QueueJobPress } from '../../parts/ui/show/queue-job/QueueJobButton';
import { answerTarget } from './records';
import { readJson } from './api';
import { AI_WORK, onStoreChange } from './store-changes';
import { sendQueuedJob } from './queue-job';
import words from './ask-my-ai.json';

type Job = { state: string; result: unknown; summary: string | null; in_the_way: string | null };

/** What the person's AI sent back: its words, and the same words as one item per paragraph for a page to place. */
export type AiAnswer = { asked_id: string; said: string; text: string; items: Array<{ text: string }> };

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The words of a finished job's result (invariant 2). */
export function answerText(job: Pick<Job, 'result' | 'summary'>): string {
  const { result } = job;
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (isObject(result)) {
    const cards = Array.isArray(result.show) ? result.show : isObject(result.show) ? [result.show] : [];
    const shown = cards.map(card => (isObject(card) && typeof card.text === 'string' ? card.text.trim() : '')).filter(Boolean);
    if (shown.length) return shown.join('\n\n');
    for (const key of words.result_text_keys) if (typeof result[key] === 'string' && (result[key] as string).trim()) return (result[key] as string).trim();
  }
  return job.summary?.trim() ?? '';
}

/** Waits for the job a press started to finish (invariant 3). */
function answerOf(askedId: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    let settled = false;
    const end = (fn: () => void) => { if (settled) return; settled = true; stop(); signal?.removeEventListener('abort', aborted); fn(); };
    const aborted = () => end(() => reject(new DOMException(words.stopped, 'AbortError')));
    const look = async () => {
      if (settled) return;
      const { jobs } = await readJson<{ jobs: Job[] }>(`/work/api/job-run?message=${encodeURIComponent(askedId)}`).catch(() => ({ jobs: [] as Job[] }));
      const stuck = jobs.find(job => job.in_the_way && job.state !== 'finished');
      if (stuck) { end(() => reject(new Error(stuck.in_the_way ?? words.no_answer))); return; }
      if (!jobs.length || !jobs.every(job => job.state === 'finished')) return;
      const text = answerText(jobs[0]);
      end(() => (text ? resolve(text) : reject(new Error(words.no_answer))));
    };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted);
    stop = onStoreChange(look, AI_WORK);
    void look();
  });
}

/** Asks the person's own AI. Resolves with its answer, or, with `wait: false`, as soon as the job is handed. */
export async function askMyAI(press: QueueJobPress, options: { signal?: AbortSignal; wait?: boolean } = {}): Promise<AiAnswer> {
  const sent = await sendQueuedJob(press);
  if (options.wait === false) return { ...sent, text: '', items: [] };
  const text = await answerOf(sent.asked_id, options.signal);
  return { ...sent, text, items: text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).map(part => ({ text: part })) };
}

// A screen's blind dispatch naming `ask-my-ai:<job id>` (invariant: the screen asks by DATA).
type Execute = { definition_id?: string; input?: { context?: unknown; request_id?: unknown } };
const jobOf = (request: unknown) => {
  const id = String((request as Execute | null)?.definition_id ?? '');
  return id.startsWith(words.definition_prefix) ? id.slice(words.definition_prefix.length) : null;
};
answerTarget('slot::workflow', async request => {
  const job_id = jobOf(request) ?? '';
  const input = (request as Execute).input ?? {};
  const given = isObject(input.context) ? input.context : {};
  const context = Object.fromEntries(Object.entries(given).map(([name, value]) => [name, typeof value === 'string' ? value : value == null ? '' : String(value)]));
  const answer = await askMyAI({ job_id, context, press_key: String(input.request_id ?? Date.now()).slice(0, 100) });
  return { status: 'completed', output: { items: answer.items, text: answer.text }, items: answer.items };
}, { handles: request => jobOf(request) !== null });
