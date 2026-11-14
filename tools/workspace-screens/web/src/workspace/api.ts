// src/workspace/api.ts
//
// PURPOSE
//   The workspace's one way to ask the Worker for the signed-in person's data. Every call goes to this page's own
//   origin with the session cookie; a signed-out session is sent to sign in; a feature the person's plan does not
//   include (the Worker's `upgrade_needed` answer) is thrown as its own `PlanNeeded`, kept apart from every failure so
//   the shared failure state (failure.ts) draws it as the plan it needs; and any other refusal is thrown with its status
//   and the Worker's words as a person may read them (the one gate, parts/ui/show/safe-error-card sanitize-error-text:
//   words written for an AI or a program become a plain line), the Worker's own words kept as `said` for the person's
//   AI when they ask it for help (never drawn). A read the page makes first (first-answers.json)
//   is answered from what the Worker wrote into the page while the page is opening, with exactly the same handling as a
//   fetched answer; an answer the page has not brought within a few seconds is asked for instead.
//   A read started ahead of time (`warmReads`, when the person points at a screen) is kept briefly and used once the
//   same way; any change the page sends drops every read kept ahead, so a kept answer never predates a change. Two
//   reads of the same address at the same moment share one request. A read the Worker answers busy (503: "send this
//   again", its store restarting or catching up) is asked again a few times, further apart, before a screen sees it.
//   Every good answer is also kept on this computer for the signed-in account (sealed under this sign-in's key), and
//   a read a screen's loader starts answers at once from that kept copy while the Worker is asked; when the Worker's
//   answer differs, the loader reads again and draws it (../../parts/ui/show/request/kept-answers.ts). A copy kept
//   before a change this page sent is never answered. A copy the page brings from the edge (`data-page-copy`, kept for
//   this sign-in by src/first-answers-copy.mjs) is drawn the same way when this computer kept none.

import { fileResultsOf, filesDoor, readFileJson as readFileJsonOf, readFileText as readFileTextOf, readWholeFile } from './files-door.mjs';
import { pageRequests } from './request-classes.ts';
import pageAccountSettings from '../page-account.json' with { type: 'json' };
import {withNativeCollectionContinuation,nativeCollectionContinuation,nativeCollectionCoverage} from '../native-collection-continuation.mjs';
import {mergeNativeHomePages} from '../native-own-home-projection.mjs';
import { sayAskedAgain } from '../../parts/ui/show/still-working/still-working.ts';
import { retryQuietly } from '../../parts/ui/show/request/quiet-retry.ts';
import { signInAddress } from './addresses.mjs';
import { sanitizeErrorText, errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import failureWords from './failure-words.json' with { type: 'json' };
import firstAnswers from './first-answers.json' with { type: 'json' };
import recordScope from '../record-scope.json' with { type: 'json' };
import { createKeptValues, forgetKeptValues } from '../../parts/ui/show/request/kept-values.ts';
import { touch, trimToBudget } from './memory-budget.ts';
import { keptAccount } from '../../parts/ui/show/page-storage/page-storage.ts';
import { keptAnswerReplaced, keptAnswerServed, keptAnswersWelcome } from '../../parts/ui/show/request/kept-answers.ts';
import readFingerprint from '../read-fingerprint.json' with { type: 'json' };
import { fingerprintOf } from '../read-fingerprint.mjs';

/** What a plan refusal names: the feature row of src/plan-comparison.json the request is (`{ id, label }`), or null
 *  when the refusal is one no feature row names. */
export type UpgradeNeeded = { feature: { id: string; label: string } | null };

/** A read or action the person's plan does not include. `message` keeps the Worker's own words (written for an AI);
 *  a screen draws `upgrade_needed` instead. */
export class PlanNeeded extends Error {
  upgrade_needed: UpgradeNeeded;
  constructor(message: string, upgrade_needed: UpgradeNeeded) {
    super(message);
    this.name = 'PlanNeeded';
    this.upgrade_needed = upgrade_needed;
  }
}

/** The answers the Worker writes into the page for the reads the page makes first (first-answers.json). The page lists
 *  the addresses being answered (the element `element_id`) and then carries each answer as its own element
 *  (`data-page-answer`) as soon as it is ready, while the script may already be running. Every read of one of those
 *  addresses while the page is opening (its first `OPENING_MS`: a screen and a sidebar list may both read it) waits
 *  for that answer instead of asking; an answer the page ends without is asked for. After the opening, or once the page
 *  has sent any change, they are gone and every read asks the Worker again, except the reads of the item the address
 *  names, each kept until its screen reads it (or a change is sent). */
type PageAnswer = { status: number; body: unknown; next_before?: string; collection_coverage?: Record<string, unknown> };
const OPENING_MS = 3000;
let pageAnswers: Map<string, Promise<PageAnswer | undefined>> | null = null;
/** The copies the page brought beside its answers (`data-page-copy`, src/first-answers-copy.mjs): kept at the edge from
 *  an earlier page of this sign-in, drawn by a loader like a copy kept on this computer while the address's own answer
 *  comes, and replaced where that answer differs. */
let pageCopies = new Map<string, PageAnswer>();
function openPageAnswers(): Map<string, Promise<PageAnswer | undefined>> {
  const answers = new Map<string, Promise<PageAnswer | undefined>>();
  pageCopies = new Map();
  if (typeof document === 'undefined') return answers;
  const listed = JSON.parse(document.getElementById(firstAnswers.element_id)?.textContent || '[]') as unknown;
  if (!Array.isArray(listed)) return answers;
  const waiting = new Map<string, (answer: PageAnswer | undefined) => void>();
  for (const path of listed) if (typeof path === 'string') answers.set(path, new Promise(resolve => waiting.set(path, resolve)));
  const sweep = () => {
    for (const element of document.querySelectorAll<HTMLElement>('script[data-page-answer]')) {
      const path = element.dataset.pageAnswer ?? '';
      if (element.dataset.pageCopy !== undefined) {
        if (!pageCopies.has(path) && waiting.has(path)) try { pageCopies.set(path, JSON.parse(element.textContent || 'null') as PageAnswer); } catch { /* a damaged copy is not drawn */ }
        continue;
      }
      const settle = waiting.get(path);
      if (!settle) continue;
      waiting.delete(path);
      try { settle(JSON.parse(element.textContent || 'null') as PageAnswer); } catch { settle(undefined); }
    }
  };
  const finish = () => { sweep(); for (const settle of waiting.values()) settle(undefined); waiting.clear(); };
  sweep();
  if (!waiting.size) return answers;
  if (document.readyState !== 'loading') { finish(); return answers; }
  const watcher = new MutationObserver(() => { sweep(); if (!waiting.size) watcher.disconnect(); });
  watcher.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { watcher.disconnect(); finish(); }, { once: true });
  return answers;
}
/** How long a read waits for the page to bring its answer before asking the Worker itself: the page keeps coming
 *  until its slowest answer is written, and on 2026-10-05 a new account's first page held two answers for over a
 *  minute while the workspace waited on them. */
const PAGE_ANSWER_WAIT_MS = 5000;
/** The page's reads of the one item its address names (first-answers.json item_reads, listed by the Worker), each
 *  with when its screen first read it: kept until then, however long the page takes to open, since that screen is sure
 *  to ask for it, and for `OPENING_MS` after, so the parts of that screen reading the same address share it. */
const itemReads = new Map<string, number | null>();
const listItemReads = () => {
  if (typeof document === 'undefined') return;
  const listed = JSON.parse(document.getElementById(firstAnswers.item_reads.element_id)?.textContent || '[]') as unknown;
  if (Array.isArray(listed)) for (const path of listed) if (typeof path === 'string') itemReads.set(path, null);
};
const stillOpening = (path: string, now: number) => {
  if (!itemReads.has(path)) return now <= OPENING_MS;
  const read = itemReads.get(path);
  return read === null || read === undefined || now <= read + OPENING_MS;
};
/** Forgets the page's answers, so the next read lists them from the page again (a test's stand-in for a new page). */
export function openPageAgain(): void { pageAnswers = null; itemReads.clear(); }
function takePageAnswer(path: string): Promise<PageAnswer | undefined> | undefined {
  if (!pageAnswers) { pageAnswers = openPageAnswers(); listItemReads(); }
  const now = performance.now();
  for (const listed of [...pageAnswers.keys()]) if (!stillOpening(listed, now)) pageAnswers.delete(listed);
  const brought = pageAnswers.get(path);
  if (!brought) pageCopies.delete(path);
  if (brought && itemReads.get(path) === null) itemReads.set(path, now);
  return brought && Promise.race([brought, new Promise<undefined>(done => setTimeout(() => done(undefined), PAGE_ANSWER_WAIT_MS))]);
}

/** The fingerprint of the answer this page holds for `path` (read-fingerprint.mjs), sent with a read so the Worker can say
 *  "the same" instead of sending the body again; null when nothing usable is held or it is too large to compare. */
function heldFingerprint(path: string): string | null {
  const text = keptText.get(path)?.text;
  if (!text) return null;
  const held = JSON.parse(text) as PageAnswer;
  if (!successful(held)) return null;
  const body = JSON.stringify(held.body);
  return body !== undefined && body.length <= readFingerprint.most_bytes ? fingerprintOf(body) : null;
}
const heldHeader = (path: string): Record<string, string> => { const have = heldFingerprint(path); return have ? { [readFingerprint.request_header]: have } : {}; };

async function fetchAnswer(path: string, init: RequestInit): Promise<PageAnswer> {
  // Every read carries the viewer's time zone, so a screen that shows times shows them in the person's own zone
  // without its address naming it (an address with no zone in it can be read ahead and kept).
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A request that never reached Trillion (offline, connection dropped) is refused in plain words, marked `unreached`,
  // so no screen ever shows the browser's own words ("Failed to fetch", "Load failed"). A stopped request stays stopped.
  // A read nobody stops gives up after READ_MOST_MS, so a store that never answers is a plain failure the screen can
  // draw with Try again, never a page left opening forever (2026-10-07). A caller's own stop stays a stop.
  const read = !init.method && !init.body && !init.signal;
  const deadline = read ? AbortSignal.timeout(READ_MOST_MS) : undefined;
  const slow = (error: unknown) => (error as { name?: string } | null)?.name === 'TimeoutError' || (deadline?.aborted ?? false);
  const response = await pageRequests.run(path, init.method, () => fetch(path, { credentials: 'same-origin', ...init, ...(deadline ? { signal: deadline } : {}), headers: { accept: 'application/json', 'x-time-zone': zone, ...(init.method && init.method !== 'GET' && keptSettings ? { [pageAccountSettings.header]: keptSettings.store } : {}), ...(read && !init.cache ? heldHeader(path) : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } }))
    .catch((error: unknown) => {
      if (slow(error)) throw Object.assign(new TypeError(failureWords.slow), { status: 0, unreached: true, slow: true });
      if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
      throw Object.assign(new TypeError(failureWords.unreached), { status: 0, unreached: true });
    });
  // The Worker answered (its status is known) and the answer then stopped partway, for example when its isolate was reset
  // while it was writing the answer. That is the service breaking, not the connection: it is answered busy, so a read asks
  // again (readWhileBusy), and a screen that still has no answer says it had a problem answering, never "could not be reached".
  const text = await response.text().catch((error: unknown) => {
    if (slow(error)) throw Object.assign(new TypeError(failureWords.slow), { status: 0, unreached: true, slow: true });
    return null;
  });
  if (text === null) return { status: 503, body: { error: failureWords.broke } };
  // The Worker said the answer is the one this page holds: use it, whole, as it was kept.
  if (response.headers.get(readFingerprint.answer_header) === '1') {
    const held = keptText.get(path)?.text;
    // What was held went away while the read was out: the busy answer asks again, with nothing held to compare.
    return held ? JSON.parse(held) as PageAnswer : { status: 503, body: { error: failureWords.broke } };
  }
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  let coverage: Record<string, unknown> | undefined;
  const coverageHeader=response.headers.get('x-trillion-collection-coverage');
  if(coverageHeader){try{coverage=JSON.parse(coverageHeader);}catch{throw new Error('The collection coverage could not be read.');}}
  return { status: response.status, body, ...(coverage?{collection_coverage:coverage}:{}), ...(response.headers.get('x-trillion-next-before') ? {next_before:response.headers.get('x-trillion-next-before')!}: {}) };
}

/** The longest one read waits for the Worker's answer before it is given up as slow (its body included). */
export const READ_MOST_MS = 60_000;

/** A read the Worker answered busy (503, 429 and the other busy answers) is asked again by itself after the waits in
 *  parts/ui/show/request/quiet-retry.json. Each asking again is said on the window (parts/ui/show/still-working), so the
 *  wait the person sees says it restarted rather than going quiet. */
const readWhileBusy = (path: string, init: RequestInit): Promise<PageAnswer> =>
  retryQuietly(() => fetchAnswer(path, init), answer => answer.status, { failures: false, onTry: attempt => sayAskedAgain({ path, attempt }) });

/** The last answer to each read, kept on this computer for the signed-in account (first-answers.json `kept`: the
 *  Worker names the account's store and this sign-in's key in the page). Missing (no store named, no IndexedDB)
 *  means nothing is kept and every read asks the Worker. As the page opens, every other account's store is deleted. */
type KeptStore = { read: <T>(key: string) => Promise<T | null>; write: (key: string, value: unknown) => Promise<void> };
// A null answer is a tombstone: the owner withdrew the previously kept content. It is distinct from having no
// copy, so an older page copy cannot fill its place when this screen or this browser page opens again.
type Kept = { answer: PageAnswer | null; at: number; refused_status?: number };
const keptSettings = keptAccount();
let keptStore: KeptStore | null = (() => {
  if (typeof indexedDB === 'undefined' || !keptSettings) return null;
  const settings = keptSettings;
  void forgetKeptValues(name => name.startsWith(firstAnswers.kept.store_prefix) && name !== settings.store);
  return createKeptValues(settings.store, { key: settings.key });
})();
/** Forgets everything this page kept on this computer for any account (the store's boot instruction `clear_cache`): the sealed answers
 *  are deleted and nothing is kept again until the page loads afresh. */
export async function clearKept(): Promise<void> {
  keepAnswersIn(null);
  if (typeof indexedDB !== 'undefined') await forgetKeptValues(name => name.startsWith(firstAnswers.kept.store_prefix));
}
/** An opaque name for the signed-in account on this computer (its store of kept answers), or null on a page that has
 *  none; what this page keeps on the device for the account carries it, so another account never finds it. */
export const deviceAccount = (): string | null => keptSettings?.store ?? null;
/** A stable number from 0 to count-1 for this account, so a rule can apply to part of the people (a test group). */
export function accountBucket(count: number): number {
  const account = deviceAccount() ?? '';
  let hash = 0;
  for (const char of account) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % count;
}
/** The text of each answer kept, so an unchanged answer is not written again. A path's writes finish in order:
 *  sealing an earlier success must not let it overwrite a later refusal tombstone. The refusal's request boundary
 *  also prevents an already pending prefetch or kept read from bringing the withdrawn answer back. */
type KeptState = { text: string | null; at: number; writing?: Promise<void>; refused?: PageAnswer; invalidatedThrough?: number };
const keptText = new Map<string, KeptState>();
/** Keeps the text of answers within the memory budget: the least recently used successful answers (not one being written, not a refusal) are let go; the device's disk still has them. */
function keepWithinBudget(): void {
  trimToBudget(keptText, state => state.text?.length ?? 0, state => state.text !== null && !state.writing && !state.refused && state.invalidatedThrough === undefined, firstAnswers.kept.max_text_chars);
}
let requestOrder = 0;
/** When this page last sent a change: an answer kept from a read that started before it is never answered again. */
let changedAt = 0;

/** Keeps answers in `store` instead (a test's stand-in), forgetting what was known of the last store. */
export function keepAnswersIn(store: KeptStore | null): void { keptStore = store; keptText.clear(); changedAt = 0; }

const successful = (answer: PageAnswer) => answer.status >= 200 && answer.status <= 299;
const definitiveRefusal = (answer: PageAnswer) => !successful(answer) && (
  (answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429)
  || (answer.body as { upgrade_needed?: unknown } | null)?.upgrade_needed === true
);

function writeKept(path: string, state: KeptState, value: Kept, previous?: Promise<void>): void {
  const store = keptStore;
  if (!store) return;
  const writing = (previous ?? Promise.resolve()).then(() => store.write(path, value)).catch(() => {});
  state.writing = writing;
  void writing.then(() => { if (state.writing === writing) delete state.writing; });
}

function forgetRefused(path: string, answer: PageAnswer): void {
  const previous = keptText.get(path);
  // A replacement read receives the very refusal that already invalidated the path.
  if (previous?.text === null && previous.refused === answer) return;
  const at = Date.now();
  const state: KeptState = { text: null, at, refused: answer, invalidatedThrough: requestOrder };
  keptText.set(path, state);
  warmed.delete(path); fresh.delete(path); inFlight.delete(path);
  pageAnswers?.delete(path); pageCopies.delete(path);
  writeKept(path, state, { answer: null, at, refused_status: answer.status }, previous?.writing);
}

/** A request already pending when this path was refused cannot restore its earlier successful answer. If a newer
 *  owner read has since restored access, use that newer answer; otherwise keep the authoritative refusal. */
function acceptedAnswer(path: string, answer: PageAnswer, order: number): PageAnswer {
  const known = keptText.get(path);
  if (successful(answer) && known?.refused && order <= (known.invalidatedThrough ?? -1)) {
    return known.text === null ? known.refused : JSON.parse(known.text) as PageAnswer;
  }
  return answer;
}

function keep(path: string, answer: PageAnswer, started: number): void {
  if (definitiveRefusal(answer)) { forgetRefused(path, answer); return; }
  if (!keptStore || !successful(answer) || started < changedAt) return;
  const text = JSON.stringify(answer);
  const previous = keptText.get(path);
  if (previous?.text === text) return;
  const state: KeptState = { ...previous, text, at: started };
  keptText.delete(path);
  keptText.set(path, state);
  keepWithinBudget();
  writeKept(path, state, { answer, at: started }, previous?.writing);
}

async function keptOf(path: string): Promise<Kept | null> {
  touch(keptText, path);
  const known = keptText.get(path);
  if (known?.text === null) return { answer: null, at: known.at, refused_status: known.refused?.status };
  const kept = keptStore ? await keptStore.read<Kept>(path) : null;
  // An asynchronous disk read may have started before the owner's refusal or a newer successful write.
  const current = keptText.get(path);
  if (current?.text === null) return { answer: null, at: current.at, refused_status: current.refused?.status };
  if (!kept || typeof kept.at !== 'number' || kept.at < changedAt || kept.answer === undefined) return null;
  if (current && current.at >= kept.at) return { answer: JSON.parse(current.text as string) as PageAnswer, at: current.at };
  if (kept.answer === null) {
    keptText.set(path, { ...current, text: null, at: kept.at, refused: { status: kept.refused_status ?? 404, body: null } });
    return kept;
  }
  keptText.delete(path);
  keptText.set(path, { ...current, text: JSON.stringify(kept.answer), at: kept.at });
  keepWithinBudget();
  return kept;
}

/** A read on its way: its answer, when it started, and the answer once it has come. */
type Asked = { answer: Promise<PageAnswer>; started: number; came?: PageAnswer };
function asked(path: string, answer: Promise<PageAnswer>, started = Date.now()): Asked {
  const order = ++requestOrder;
  const one: Asked = { answer, started };
  one.answer = answer.then(came => {
    const accepted = acceptedAnswer(path, came, order);
    one.came = accepted;
    if (accepted === came) keep(path, came, started);
    return accepted;
  });
  one.answer.catch(() => {});
  return one;
}

/** Reads started ahead of time, each used once within `WARM_MS` of starting. */
const WARM_MS = 10000;
const warmed = new Map<string, Asked & { until: number }>();

/** Starts reading `paths` now, so the screen that asks for them next finds them already on their way. */
export function warmReads(paths: readonly string[]): void {
  const now = Date.now();
  for (const path of paths) {
    const kept = warmed.get(path);
    if (kept && kept.until > now) continue;
    const answer = fetchAnswer(path, {});
    answer.catch(() => { if (warmed.get(path)?.answer === answer) warmed.delete(path); });
    warmed.set(path, { ...asked(path, answer, now), until: now + WARM_MS });
  }
}

function takeWarmed(path: string, init: RequestInit): Asked | undefined {
  const kept = warmed.get(path);
  warmed.delete(path);
  if (!kept || kept.until <= Date.now()) return undefined;
  // A read started ahead that the Worker answered busy is asked again the way every read is.
  return { ...kept, answer: kept.answer.then(answer => (answer.status === 503 ? readWhileBusy(path, init) : answer)) };
}

/** An answer that replaced a kept copy, used by the read the replacement brings, so it never asks twice. */
const FRESH_MS = 5000;
const fresh = new Map<string, { answer: PageAnswer; until: number }>();
function takeFresh(path: string): PageAnswer | undefined {
  const kept = fresh.get(path);
  fresh.delete(path);
  return kept && kept.until > Date.now() ? kept.answer : undefined;
}

const inFlight = new Map<string, Asked>();

/** The read of `path` on its way: started ahead, already being asked, or asked now. Two parts of the page reading
 *  the same address at the same moment (a screen and a sidebar list) share one request. */
function ask(path: string, init: RequestInit): Asked {
  const ahead = takeWarmed(path, init);
  if (ahead) return ahead;
  let one = inFlight.get(path);
  if (!one) {
    const reading = asked(path, readWhileBusy(path, init));
    reading.answer = reading.answer.finally(() => { if (inFlight.get(path) === reading) inFlight.delete(path); });
    one = reading;
    inFlight.set(path, one);
  }
  return one;
}

async function answerOf(path: string, init: RequestInit, repeatable = false): Promise<PageAnswer> {
  // Current policy and exact owner readbacks may use the fresh page answer, never a saved device/edge copy.
  if (init.cache === 'no-store' && !init.method && !init.body) {
    const pending = takePageAnswer(path);
    // Consume the startup answer once. A policy refresh after a live change cannot reuse it or a warmed request
    // started before that change, even if the page is still in its opening window.
    pageAnswers?.delete(path);
    pageCopies.delete(path);
    return pending ? pending.then(page => page && page.status !== 503 ? page : readWhileBusy(path, init)) : readWhileBusy(path, init);
  }
  // Whether a kept copy may answer is known only as the read starts (../../parts/ui/show/request/kept-answers.ts).
  const welcome = keptAnswersWelcome();
  if (init.method || init.body) {
    // A change: nothing read before it is handed to a read after it.
    if (init.body || init.method?.toUpperCase() !== 'GET') { warmed.clear(); inFlight.clear(); fresh.clear(); pageAnswers = new Map(); changedAt = Date.now(); }
    // A change its sender made safe to send twice (it names a request key, so the store answers a repeat with the
    // first run) is sent again while the Worker answers busy, like a read; any other change is sent once.
    return repeatable ? readWhileBusy(path, init) : fetchAnswer(path, init);
  }
  const replaced = takeFresh(path);
  if (replaced) return replaced;
  // An answer the page is bringing is this read's answer (asked for when the page ends without it, or it came busy).
  const pending = takePageAnswer(path);
  const one = pending ? asked(path, pending.then(page => (page && page.status !== 503 ? page : readWhileBusy(path, init))), performance.timeOrigin) : ask(path, init);
  // The copy the page brought from the edge, when this computer kept none of its own (a new device, cleared storage).
  const copied = pending ? pageCopies.get(path) : undefined;
  pageCopies.delete(path);
  if (!welcome || (!keptStore && !copied)) return one.answer;
  // Whichever comes first answers: the kept copy, or the Worker's answer when it arrives before the copy is read.
  const keptRead = (keptStore ? keptOf(path) : Promise.resolve(null)).then(kept => kept
    ?? (copied && keptText.get(path)?.text !== null ? { answer: copied, at: performance.timeOrigin } : null));
  const first = await Promise.race([one.answer.then(() => null, () => null), keptRead]);
  const kept = first ?? null;
  if (one.came || !kept?.answer) return one.answer;
  // Drawn now from the kept copy; if the Worker's answer differs, the loaders that drew it read again and get it.
  keptAnswerServed();
  one.answer.then(answer => {
    if (answer.status >= 500 || JSON.stringify(answer) === JSON.stringify(kept.answer)) return;
    fresh.set(path, { answer, until: Date.now() + FRESH_MS });
    keptAnswerReplaced(path);
  }, () => {});
  return kept.answer;
}

// The person's Focus on every list (scope-focus.ts): while a focus is chosen, a read of any list src/record-scope.json
// names carries `scope`, so the Worker answers only what is in it (src/work-scope.mjs). The lists and the narrowing
// stay the Worker's; this only adds the parameter a list read already takes.
let focusScope: string | null = null;
const SCOPED_LISTS = (recordScope.lists as { path: (string | { param: string })[] }[]).map(list => list.path);
/** Narrow every list read from now on by this scope (JSON, such as `{"saved":"app"}`), or by nothing. */
export function narrowListsBy(scope: string | null): void {
  if (scope === focusScope) return;
  focusScope = scope;
  warmed.clear(); fresh.clear(); inFlight.clear(); pageAnswers = new Map();
}
function focused(path: string): string {
  if (!focusScope) return path;
  const [address, query = ''] = path.split('?');
  if (new URLSearchParams(query).has('scope')) return path;
  const segments = address.split('/').filter(Boolean);
  const listed = SCOPED_LISTS.some(parts => parts.length === segments.length && parts.every((part, at) => typeof part !== 'string' || part === decodeURIComponent(segments[at])));
  return listed ? `${path}${query ? '&' : '?'}scope=${encodeURIComponent(focusScope)}` : path;
}

export async function readJson<T>(path: string, init: RequestInit = {}, repeatable = false, options: { applyFocus?: boolean } = {}): Promise<T> {
  const order = ++requestOrder;
  const address = init.method || init.body || options.applyFocus === false ? path : focused(path);
  const reading = !init.body && (!init.method || init.method.toUpperCase() === 'GET');
  const received = await answerOf(address, init, repeatable);
  const answer = reading ? acceptedAnswer(address, received, order) : received;
  if (reading && definitiveRefusal(answer)) forgetRefused(address, answer);
  const { status, body } = answer;
  if (status === 401) {
    // The whole address comes back after signing in, with what its query asks for (a meeting link, a tab's item).
    location.assign(signInAddress(`${location.pathname}${location.search}${location.hash}`));
    throw Object.assign(new Error('Sign in again to continue.'), { status: 401 });
  }
  if (status < 200 || status > 299) {
    const refusal = body as { error?: string; failure_code?: string; refused?: { code?: string }; outcome?: unknown; request_key?: unknown; upgrade_needed?: boolean; feature?: { id: string; label: string }; problems?: unknown[]; missing_connection?: string; step_needed?: string; change?: unknown; next?: { label?: unknown; href?: unknown } } | null;
    const said = typeof refusal?.error === 'string' ? refusal.error : '';
    if (refusal?.upgrade_needed === true) throw new PlanNeeded(said, { feature: refusal.feature ?? null });
    // No owner answers this address in the running Trillion (404 failure_code no-owner, final): the part is absent, not
    // broken and not out of reach, so it is said that way and never asked again by itself.
    if (status === 404 && refusal?.failure_code === 'no-owner') throw Object.assign(new Error(failureWords.absent), { status, absent: true });
    const words = sanitizeErrorText(said, status >= 500 ? failureWords.broke : failureWords.refused);
    // A refusal that names its reasons one by one (a set of rules, each reason with the rule it is about) keeps them.
    // A refusal that names a connection the person has not made yet keeps its name, so a screen can say "connect it".
    // A refusal that names the one change a passkey must confirm keeps it, so the page confirms exactly that change.
    // Preserve the owner's known outcome and original key for recovery. An unknown result must never become a fresh
    // unkeyed attempt in a control.
    const outcome = refusal?.outcome === 'unknown' || refusal?.outcome === 'not_started' ? refusal.outcome : undefined;
    const requestKey = typeof refusal?.request_key === 'string' && refusal.request_key ? refusal.request_key : undefined;
    throw Object.assign(new Error(words), { status, said, ...(outcome ? { outcome } : {}), ...(requestKey ? { request_key: requestKey } : {}), ...(Array.isArray(refusal?.problems) ? { problems: refusal.problems } : {}), ...(typeof refusal?.refused?.code === 'string' ? { refused: refusal.refused } : {}), ...(typeof refusal?.missing_connection === 'string' ? { missing_connection: refusal.missing_connection } : {}), ...(typeof refusal?.step_needed === 'string' ? { step_needed: refusal.step_needed } : {}), ...(refusal?.change && typeof refusal.change === 'object' ? { change: refusal.change } : {}), ...(typeof refusal?.next?.label === 'string' && typeof refusal.next.href === 'string' ? { next: { label: refusal.next.label, href: refusal.next.href } } : {}) });
  }
  if (body === null) throw new Error('The answer could not be read. Try again.');
  return withNativeCollectionContinuation(body,answer.next_before,answer.collection_coverage) as T;
}

/** Read the item an address explicitly selected, independently of optional list Focus. Authentication, owner
 *  authorization, explicit query scope, cache isolation and refusal handling remain the same as every read. */
/** Complete a screen's collection through fresh bounded owner pages. This
 * preserves its existing renderer and filters, including empty continued pages. */
export async function readCollectionJson<T>(path: string): Promise<T> {
  const pages: any[] = []; let cursor: string | null = null; const seen = new Set<string>();
  do {
    const url = new URL(path, typeof location === 'undefined' ? 'https://native.invalid' : location.origin);
    if(cursor) url.searchParams.set('cursor',cursor);
    const page = await readJson<any>(cursor ? url.pathname+url.search : path);
    pages.push(page);
    cursor = page?.next_before ?? page?.next ?? page?.[nativeCollectionContinuation] ?? null;
    if(cursor){if(seen.has(cursor))throw new Error('The collection did not advance. Try again.');seen.add(cursor);}
  } while(cursor);
  if(pages.some(page=>Array.isArray(page?.helped_items)))return mergeNativeHomePages(pages) as T;
  const sourceCoverage=pages.map(page=>page?.collection_coverage??page?.[nativeCollectionCoverage]).filter(Boolean);
  const coverage=sourceCoverage.length?{...sourceCoverage.at(-1),published_snapshot_complete:true,current_membership_complete:false,source_pages:pages.length,source_projection_pending:sourceCoverage.some(row=>row.source_projection_pending===true),projection_stale:sourceCoverage.some(row=>row.projection_stale===true)}:undefined;
  if(Array.isArray(pages[0]))return withNativeCollectionContinuation(pages.flat(),null,coverage) as T;
  const last=pages.at(-1),result={...last};
  if(coverage)result.collection_coverage=coverage;
  for(const field of ['lists','conversations','messages','pursuits','cards','summaries','decisions','work']){
    if(!Array.isArray(last?.[field]))continue;
    const rows=new Map();for(const page of pages)for(const row of page[field]??[]){const key=row.id??row.case_id??row.task_id??row.handoff_id;if(key===undefined)throw new Error('The collection lacks its stable record identity.');const prior=rows.get(key);if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw new Error('The collection changed during reading. Try again.');rows.set(key,row);}result[field]=[...rows.values()];
  }
  return result as T;
}

export const readItemJson = <T>(path: string) => readJson<T>(path, {}, false, { applyFocus: false });

export const postJson = <T>(path: string, value: unknown) => readJson<T>(path, { method: 'POST', body: JSON.stringify(value) });


// The person's files on their computer: the engine's files door at /work/api/files/<operation> (files-door.mjs), the
// same operations an AI's key reaches there. A read is a GET, so its answer is not focused onto another address.
export const files = filesDoor((path: string, init: RequestInit) => init.method ? readJson(path, init) : readItemJson(path));

// One file by its name or any identity (the door's find_file: {identity, media_type, byte_length, names, aliases, ...}).
export const readFileLookup = <T>(ref: string) => files.read('find_file', { name_or_identity: ref }) as Promise<T>;

// A whole small file by its name or any identity, read in the door's read_file windows (files-door.mjs readWholeFile).
export const readFileJson = <T>(ref: string) => readFileJsonOf(files.read, ref) as Promise<T>;
export const readFileText = (ref: string) => readFileTextOf(files.read, ref) as Promise<string>;
export const readFileBytes = (ref: string, most?: number) => readWholeFile(files.read, ref, most ? { most } : {}) as Promise<Uint8Array>;

// What was worked out about files (trillion-rust src/account_files/results.rs, the port of old trillion's
// /namespace/results routes): the files door's results operations, answering as those routes did. A read is the
// door's GET (so its address can be read again or kept as a path); the rest are its POSTs (files-door.mjs fileResultsOf).
const results = fileResultsOf(files);
export const fileResultsPath = (identity: string, kind?: string | null): string => results.path(identity, kind);
export const fileResults = {
  read: <T>(identity: string, kind?: string | null) => results.read(identity, kind) as Promise<T>,
  record: <T = unknown>(rows: unknown[]) => results.record(rows) as Promise<T>,
  merge: <T = unknown>(identity: string, change: { kind: string; value: unknown; produced_by?: string | null; only_if_empty?: boolean }) =>
    results.merge(identity, change) as Promise<T>,
  many: <T = unknown>(kind: string, identities: string[]) => results.many(kind, identities) as Promise<T>,
};

// One page of a folder's names (the files door's list_files: {collection, names, next_after, folders}).
export const readListing = <T>(collection: string, extra: { limit?: number; after?: string } = {}) => files.read('list_files', { folder: collection, ...extra }) as Promise<T>;
export const putJson = <T>(path: string, value: unknown) => readJson<T>(path, { method: 'PUT', body: JSON.stringify(value) });
/** A write that changes nothing any read shows (a device telling the store it is here): sent as `postJson` is, but the
 *  copies kept on this device and the answers the page brought still answer every read after it. Any other write
 *  makes every read after it ask the Worker, so a write sent at every open (2026-10-05: POST /catch-up/here) held
 *  every screen on the person's store on every open. */
export async function postNothingRead<T>(path: string, value: unknown): Promise<T> {
  const answer=await fetchAnswer(path, { method: 'POST', body: JSON.stringify(value) });
  const {status,body}=answer;
  if (status < 200 || status > 299) throw Object.assign(new Error(sanitizeErrorText(typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '', status >= 500 ? failureWords.broke : failureWords.refused)), { status });
  return withNativeCollectionContinuation(body,answer.next_before,answer.collection_coverage) as T;
}
/** A change carrying its own request key: sent again while the Worker answers busy, since a repeat is the same run. */
export const postJsonByKey = <T>(path: string, value: { request_key: string }) => readJson<T>(path, {
  method: 'POST', body: JSON.stringify(value), headers: { 'idempotency-key': value.request_key },
}, true);

/** The Worker's answer or its refusal, for a screen that draws each refusal as its own state instead of an error:
 *  `{ ok: true, value }`, or `{ ok: false, status, error }` in the Worker's own words. A plan refusal is not one of
 *  these: it stays a `PlanNeeded`, so every screen shows the same plan state. */
export type Answer<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
export async function readAnswer<T>(path: string): Promise<Answer<T>> {
  try { return { ok: true, value: await readJson<T>(path) }; } catch (error) {
    if (error instanceof PlanNeeded) throw error;
    const status = (error as { status?: number }).status ?? 0;
    return { ok: false, status, error: errorWords(error) };
  }
}

/** Reads the body of a direct answer (`response.json()`, `response.text()`) the way fetchAnswer does: a body that breaks
 *  after the Worker answered is the service breaking, so it is refused as busy (503) in the broke words, never as an
 *  unreached connection (the browser's own "network error" text). A stopped read stays stopped. */
export async function bodyOf<T>(response: Response, read: (response: Response) => Promise<T>): Promise<T> {
  return read(response).catch((error: unknown) => {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw Object.assign(new TypeError(failureWords.broke), { status: 503 });
  });
}
