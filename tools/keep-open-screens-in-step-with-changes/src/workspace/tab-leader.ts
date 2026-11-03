// src/workspace/tab-leader.ts
//
// PURPOSE
//   The one way the tabs of a browser share work that must happen once: elect one tab to own a job (the live socket) and
//   run a poll in exactly one tab. Built on Web Locks: a lock is
//   held by exactly one tab and passes to the next waiting tab the moment its holder closes, crashes or navigates away.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A name is led by at most one tab at a time; when the leader goes, the next tab waiting for that name takes over
//      at once, with no timer or heartbeat.
//   2. `inOneTab` runs only where the lock is free right now (ifAvailable): a tab that finds it held skips the run, it
//      does not queue one, so N tabs make one run per tick.
//   3. A browser without Web Locks makes every tab its own leader and every tab run: the work is done once per tab, as
//      before sharing existed, never skipped.
//   4. Stopping releases the lock or the wait; nothing here keeps a tab alive.

/** The part of the Web Locks API used here, so a test can stand in for the browser. */
export type Locks = { request: (name: string, options: { ifAvailable?: boolean; signal?: AbortSignal; mode?: 'exclusive' | 'shared' }, run: (lock: unknown) => unknown) => Promise<unknown> };

const browserLocks = (): Locks | null => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks as unknown as Locks : null);

/** Whether tabs can share work here (Web Locks exist). */
export const canShareTabs = (locks: Locks | null = browserLocks()): boolean => locks !== null;

/** Runs `run` when this tab leads `name`, and keeps leading until the returned function is called or the tab closes. `run` may
 *  answer a function that is called when leading ends. Without Web Locks it runs at once. */
export function leadBrowser(name: string, run: () => void | (() => void), locks: Locks | null = browserLocks()): () => void {
  if (!locks) { const end = run(); return () => { if (end) end(); }; }
  const waiting = new AbortController();
  let release: (() => void) | null = null;
  let stopped = false;
  let entered = false;
  Promise.resolve().then(() => locks.request(name, { signal: waiting.signal }, () => new Promise<void>(done => {
    if (stopped) { done(); return; }
    entered = true;
    const end = run();
    release = () => { if (end) end(); done(); };
  }))).catch(error => {
    // Sandboxed AI-app frames can expose the API while denying its use.
    // Fall back only before any work started; a callback failure never runs twice.
    if (stopped || entered || error?.name !== 'SecurityError') return;
    entered = true;
    const end = run();
    release = () => { if (end) end(); };
  });
  return () => { stopped = true; waiting.abort(); release?.(); release = null; };
}

/** Runs `work` only if no other tab is running `name` right now; answers whether it ran. Without Web Locks it always runs. */
export async function inOneTab(name: string, work: () => void | Promise<void>, locks: Locks | null = browserLocks()): Promise<boolean> {
  if (!locks) { await work(); return true; }
  let ran = false;
  let entered = false;
  try {
    await locks.request(name, { ifAvailable: true }, async lock => { entered = true; if (!lock) return; ran = true; await work(); });
  } catch (error) {
    if (entered || (error as { name?: string })?.name !== 'SecurityError') throw error;
    await work();
    return true;
  }
  return ran;
}
