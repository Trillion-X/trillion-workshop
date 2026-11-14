// packages/ui/show/load-later/load-code.ts
//
// Purpose: the one way the page fetches code it did not carry at first (a screen, a part drawn later) and mends a fetch
// that failed, so a dropped connection or a damaged copy heals by itself instead of leaving a screen broken until the
// whole page is reloaded.
//
// Non-negotiable invariants:
// - A browser keeps a module fetch that failed for the life of the page (seen in Chromium 153 on 2026-10-17: a second
//   import() of the same address fails at once and nothing is fetched). Asking the same address again cannot mend it,
//   so the file is asked again at a new address, `<address>?again=<n>`, which the Worker answers with the same bytes
//   (it serves content-named files by path). `pick` then takes the value from that copy, the same as from the first.
// - Before asking again it waits: the waits in CODE_WAITS_MS, and always until the page is shown, so a hidden tab
//   never spends its tries. A device that is offline when a try is due is `unreached` at once, so the person sees why
//   instead of a loading state with no end; the caller asks again by itself when the device is back online
//   (whenOnline), and Try again asks at once.
// - The file is asked again first. Only when that ask fails is its address checked without the browser's copy (HEAD,
//   no-store), so a page that may not make that check (a frame that blocks fetch) still heals: gone (404 or 410)
//   means a newer Trillion replaced it, which no retry mends, so the answer is `replaced`.
// - Code that arrived and then failed while running is `broken`, and so is a module without the value `pick` takes:
//   asking again cannot change it.
// - A failure the page cannot mend in place is `stuck`: only reloading the page fetches it again. That is a file the
//   screen's code imports failing (the browser keeps that failure too, so the file the server has fails twice), or a
//   failure that names no file (Safari's words) that `load` asked once more still gives.
// - One failed address is mended once for the whole page: every caller of the same file shares the copy fetched at the
//   new address, so a module several parts import is never run twice.
// - Every failure is a CodeLoadFailure naming one reason; a caller draws its words, never the browser's error text.

/** Why code could not be had: a newer build replaced it, the connection did not come back within the tries, the page
 *  must be reloaded to fetch it, or it arrived and failed while running. */
export type CodeLoadReason = 'replaced' | 'unreached' | 'stuck' | 'broken';

export class CodeLoadFailure extends Error {
  readonly reason: CodeLoadReason;
  constructor(reason: CodeLoadReason, cause: unknown) {
    super(`The code could not be had (${reason}).`, { cause });
    this.name = 'CodeLoadFailure';
    this.reason = reason;
  }
}

/** The waits before each new ask, in milliseconds: they double from half a second and stop at thirty. */
export const CODE_WAITS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000];

/** What the loader reads from the page and the network; the page's own by default, given by a test. */
export type CodeLoadPlace = {
  /** Resolves once the page is shown. */
  ready: () => Promise<void>;
  /** Whether the device says it has a connection now. */
  online: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** The file at `url` as the server has it now: present, gone (replaced by a newer build) or not reached. */
  check: (url: string) => Promise<'present' | 'gone' | 'unreached'>;
  /** Imports the module at an address the page has not asked before. */
  importFresh: (url: string) => Promise<unknown>;
};

// A module fetch that failed, in the words each browser uses: Chromium names the file, Firefox names it too, Safari
// says only that importing failed.
const FETCH_FAILED = /dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to fetch|load failed|networkerror/i;
const ADDRESS = /https?:\/\/[^\s'"<>]+/;

/** The address of the file whose fetch failed, when `error` is a failed module fetch that names one; null when it
 *  names none; undefined when `error` is not a failed fetch at all (the code arrived and failed while running). */
export function failedFetchAddress(error: unknown): string | null | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!FETCH_FAILED.test(message)) return undefined;
  const found = message.match(ADDRESS)?.[0]?.replace(/[.,;:)]+$/, '');
  return found ?? null;
}

// Each address asked again gets its own next number for the life of the page, so no new ask reuses an address whose
// failure the browser keeps.
const asksAgain = new Map<string, number>();
function freshAddress(url: string): string {
  const next = (asksAgain.get(url) ?? 0) + 1;
  asksAgain.set(url, next);
  const address = new URL(url);
  address.searchParams.set('again', String(next));
  return address.href;
}

// The copy each failed address was mended with, shared by every caller of that file; a copy that failed is let go of,
// so the next ask fetches another.
const mended = new Map<string, Promise<unknown>>();
function mendedCopy(url: string, place: CodeLoadPlace): Promise<unknown> {
  let copy = mended.get(url);
  if (!copy) {
    const asked = place.importFresh(freshAddress(url));
    mended.set(url, asked);
    asked.catch(() => { if (mended.get(url) === asked) mended.delete(url); });
    copy = asked;
  }
  return copy;
}

const pageOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function pageShown(): Promise<void> {
  const shown = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  if (shown()) return Promise.resolve();
  return new Promise(resolve => {
    const settle = () => {
      if (!shown()) return;
      document.removeEventListener('visibilitychange', settle);
      resolve();
    };
    document.addEventListener('visibilitychange', settle);
  });
}

/** Runs `again` once when the device comes back online (code that was `unreached` asks again by itself); the answer
 *  stops waiting. */
export function whenOnline(again: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const back = () => { window.removeEventListener('online', back); again(); };
  window.addEventListener('online', back);
  return () => window.removeEventListener('online', back);
}

const CHECK_MOST_MS = 10000;

export const pagePlace: CodeLoadPlace = {
  ready: pageShown,
  online: pageOnline,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  check: async url => {
    try {
      const answer = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(CHECK_MOST_MS) });
      if (answer.status === 404 || answer.status === 410) return 'gone';
      return answer.ok ? 'present' : 'unreached';
    } catch {
      return 'unreached';
    }
  },
  importFresh: url => import(url),
};

/**
 * The value `pick` takes from the module `load` imports, mended as this file's invariants say when the import fails.
 * `load` is the plain `() => import('./x')` the build splits into its own file.
 */
export async function loadCode<M, T>(load: () => Promise<M>, pick: (module: M) => T, { place = pagePlace, waits = CODE_WAITS_MS }: { place?: CodeLoadPlace; waits?: readonly number[] } = {}): Promise<T> {
  // A caller that passed no pick (the one-argument later(load) form) is broken before anything is fetched.
  if (typeof pick !== 'function') throw new CodeLoadFailure('broken', new TypeError('loadCode was given no pick, the function that takes the value from the module load imports.'));
  const picked = (module: M): T => {
    const value = pick(module);
    if (value === undefined || value === null) throw new CodeLoadFailure('broken', new TypeError('pick took nothing from the module: the export it names is missing.'));
    return value;
  };
  // What a failed ask means: a CodeLoadFailure stands; otherwise broken when the code arrived and failed while running.
  const meaning = (error: unknown) => (error instanceof CodeLoadFailure ? error : failedFetchAddress(error) === undefined ? new CodeLoadFailure('broken', error) : null);
  let failure: unknown;
  try {
    return picked(await load());
  } catch (error) {
    failure = error;
  }
  const said = meaning(failure);
  if (said) throw said;
  const address = failedFetchAddress(failure);
  if (!address) {
    // The browser named no file: `load` is asked once more, which mends it where the browser does not keep the failure.
    await place.sleep(waits[0] ?? 0);
    await place.ready();
    if (!place.online()) throw new CodeLoadFailure('unreached', failure);
    try { return picked(await load()); } catch (error) { throw meaning(error) ?? new CodeLoadFailure('stuck', error); }
  }
  // Another caller already mended this file: its copy serves this caller at once.
  const known = mended.get(address);
  if (known) {
    try { return picked(await known as M); } catch { /* that copy failed and was let go of; this caller asks below */ }
  }
  // A file the server has that still fails twice means a file it imports failed, which the browser keeps.
  let presentButFailed = 0;
  for (const wait of waits) {
    if (!place.online()) throw new CodeLoadFailure('unreached', failure);
    await place.sleep(wait);
    await place.ready();
    if (!place.online()) throw new CodeLoadFailure('unreached', failure);
    try {
      return picked(await mendedCopy(address, place) as M);
    } catch (error) {
      failure = error;
      const failed = meaning(error);
      if (failed) throw failed;
    }
    const seen = await place.check(address);
    if (seen === 'gone') throw new CodeLoadFailure('replaced', failure);
    if (seen === 'present' && ++presentButFailed >= 2) throw new CodeLoadFailure('stuck', failure);
  }
  throw new CodeLoadFailure('unreached', failure);
}
