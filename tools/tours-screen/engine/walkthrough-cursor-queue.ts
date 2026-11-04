export interface QueuedCursorTransition<T> {
  readonly previous: T;
  readonly next: T;
  readonly cause: 'advance' | 'back';
}

export type CursorTransitionOutcome<T> =
  | { readonly kind: 'accepted'; readonly cursor: T }
  | { readonly kind: 'stale'; readonly cursor: T };

export interface CursorTransitionQueueOptions<T> {
  readonly initial: T;
  readonly persist: (transition: QueuedCursorTransition<T>) => Promise<CursorTransitionOutcome<T>>;
  readonly same: (left: T, right: T) => boolean;
  readonly onVisible: (cursor: T) => void;
  readonly onSaving: (saving: boolean) => void;
  readonly onFailure: (error: unknown) => void;
  readonly onComplete: (cursor: T) => void;
}

/** Keeps the walkthrough responsive while its owner serializes compare-and-set writes. */
export function createCursorTransitionQueue<T extends { readonly status: string }>(
  options: CursorTransitionQueueOptions<T>,
) {
  let visible = options.initial;
  let authoritative = options.initial;
  const queued: QueuedCursorTransition<T>[] = [];
  const waiters: Array<(saved: boolean) => void> = [];
  let running = false;
  let failed = false;
  let failure: unknown;
  let completed = false;

  const settleWaiters = (saved: boolean) => {
    for (const resolve of waiters.splice(0)) resolve(saved);
  };

  const drain = async (): Promise<void> => {
    if (running || failed || queued.length === 0) return;
    running = true;
    options.onSaving(true);
    try {
      while (queued.length > 0) {
        const transition = queued[0];
        let outcome: CursorTransitionOutcome<T>;
        try {
          outcome = await options.persist(transition);
        } catch (error) {
          failed = true;
          failure = error;
          break;
        }
        if (outcome.kind === 'stale') {
          queued.length = 0;
          authoritative = outcome.cursor;
          visible = outcome.cursor;
          options.onVisible(visible);
          break;
        }
        queued.shift();
        authoritative = outcome.cursor;
        if (!options.same(outcome.cursor, transition.next)) {
          // The owner accepted a different current cursor; later actions were based on stale display state.
          queued.length = 0;
          visible = outcome.cursor;
          options.onVisible(visible);
          break;
        }
        if (queued.length === 0) {
          visible = outcome.cursor;
          options.onVisible(visible);
        }
      }
    } finally {
      running = false;
      options.onSaving(false);
      if (failed) {
        options.onFailure(failure);
        settleWaiters(false);
      } else {
        settleWaiters(true);
        if (queued.length > 0) void drain();
        else if (authoritative.status === 'complete' && !completed) {
          completed = true;
          options.onComplete(authoritative);
        }
      }
    }
  };

  return {
    enqueue(next: T, cause: 'advance' | 'back'): void {
      if (queued.some((transition) => transition.next.status === 'complete')) return;
      const transition = { previous: visible, next, cause };
      queued.push(transition);
      if (next.status !== 'complete') {
        visible = next;
        options.onVisible(visible);
      }
      void drain();
    },
    retry(): void {
      if (!failed) return;
      failed = false;
      failure = undefined;
      void drain();
    },
    flush(): Promise<boolean> {
      if (failed) return Promise.resolve(false);
      if (!running && queued.length === 0) return Promise.resolve(true);
      return new Promise((resolve) => waiters.push(resolve));
    },
    get current(): T {
      return visible;
    },
    get pendingCount(): number {
      return queued.length;
    },
  };
}
