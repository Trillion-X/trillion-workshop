// parts/ui/show/request/quiet-retry.ts
//
// PURPOSE
//   A busy service is waited out quietly. A read that could not reach Trillion, timed out, or was told it is busy asks
//   again by itself, after the waits in quiet-retry.json, while the screen keeps its calm loading state; only when the
//   last wait has passed does the screen say so and offer Try again.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The waits and the busy answers are DATA (quiet-retry.json); nothing here names a number.
//   2. Only busy is retried: an unreached request, a timeout, or a busy status. A refusal (4xx other than 408, 425, 429),
//      a plan refusal or a stopped request is final at once and is never asked again.
//   3. Nothing is said while it waits: no error, no count. Each new try is announced on the window (still-working) so a wait
//      the person sees says it restarted rather than going quiet.
//   4. After the last wait the last failure is thrown unchanged, for the shared failed state to word.

import policy from './quiet-retry.json' with { type: 'json' };

export type QuietRetryPolicy = { waits_ms: readonly number[]; busy_statuses: readonly number[] };
export const QUIET_RETRY: QuietRetryPolicy = policy;

/** Whether a failure (a thrown error, or an answer's status) means busy now rather than refused. */
export function isBusy(failure: unknown, rules: QuietRetryPolicy = QUIET_RETRY): boolean {
  const mark = failure as { name?: string; status?: unknown; unreached?: unknown } | null;
  if (mark?.name === 'AbortError') return false;
  if (mark?.unreached === true) return true;
  const status = typeof failure === 'number' ? failure : mark?.status;
  return status === 0 || (typeof status === 'number' && rules.busy_statuses.includes(status));
}

type Options = {
  rules?: QuietRetryPolicy;
  /** Waits `ms`; a test hands a stand-in so no real time passes. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /** Said as each new try begins (1 for the first): the window's still-working signal. */
  onTry?: (attempt: number) => void;
  /** Whether a thrown busy failure (unreached, timed out) is asked again too; false asks again only a busy answer. */
  failures?: boolean;
  /** Stop the local wait and further attempts; an already dispatched effect may still have run. */
  signal?: AbortSignal | null;
};
const realSleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((done, reject) => {
  signal?.throwIfAborted();
  const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); done(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});

function untilStopped<T>(operation: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); },
    );
  });
}

/** Runs `attempt`; while its failure, or the status `statusOf` finds in its answer, means busy, waits and runs it again. */
export async function retryQuietly<T>(attempt: () => Promise<T>, statusOf: (answer: T) => number | null, options: Options = {}): Promise<T> {
  const { rules = QUIET_RETRY, sleep = realSleep, onTry, failures = true, signal } = options;
  for (let tried = 0; ; tried += 1) {
    let failure: unknown = null;
    let answer: T | undefined;
    try {
      answer = await untilStopped(attempt, signal);
      signal?.throwIfAborted();
      const status = statusOf(answer);
      if (status === null || !isBusy(status, rules)) return answer;
    } catch (error) {
      signal?.throwIfAborted();
      if (!failures || !isBusy(error, rules)) throw error;
      failure = error;
    }
    if (tried >= rules.waits_ms.length) {
      if (failure) throw failure;
      return answer as T;
    }
    await untilStopped(() => sleep(rules.waits_ms[tried], signal), signal);
    signal?.throwIfAborted();
    onTry?.(tried + 1);
  }
}
