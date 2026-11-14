// src/workspace/share-outbox.ts
//
// PURPOSE
//   A share sent from the web (the message box, the tray) is never lost when the account cannot be reached. The whole
//   request ({ request_key, ...body }) is written to this device BEFORE it is posted, and removed only when the account
//   answered it (200, or 202 `{ queued: true }`: the account kept it at its edge). A request that did not get through
//   (offline, the account busy, a 5xx, a session that needs signing in again) stays, and is sent again with the SAME
//   request_key (the account answers a repeated key with the first send's answer, so a retry never doubles a share)
//   when the page loads, when the browser comes back online, when the window gets focus, and every minute.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Written before posted: a page closed mid-send still has the share.
//   2. A retry always carries the key the share was kept with; nothing here makes a new key for a kept share.
//   3. Only a failure a retry can fix is kept (`retryable`); a refusal in words (a plan, a bad request) is said to the
//      person and the share is let go, since sending it again cannot change the answer.
//   4. A share leaves the outbox only when the account answered it. A share older than KEPT_MOST_MS is let go, said once.
//   5. The store is the page's localStorage when it has one; when it cannot be written (full, private mode) the shares
//      are held in memory so the retries in this page still run.
//   6. One outbox, any idempotent write: a kept row may name its own `path` and the `key_field` its key travels in
//      (a message to the AIs: /work/api/messages/send-all with `client_id`, src/workspace/send-message.ts); a row naming
//      neither is a share. Kept rows can be sent again at once (`resend`) or let go (`cancel`), so a send that is
//      waiting is never stuck where the person cannot reach it.
//   7. A kept row may carry `meta`: what a screen needs to show it while it waits (the conversation and words of a
//      message). It is never posted; the account sees only `body`.
//   8. A share let go (refused in words, a place that stopped it, or too old) is not lost silently: it moves to the dead
//      letters (DEAD_STORAGE_KEY, same account stamp) with the words it was let go in. The person can send it again
//      (a NEW request_key, since the account would answer the old key with its first answer) or discard it.
//   9. Of the tabs of one browser, only one sends kept shares again at each tick (tab-leader.ts inOneTab, DRAIN_LOCK); a
//      tab that finds another sending skips that tick. Sends are safe to repeat either way (the same request_key).
//   10. Each share is stamped with the signed-in account it was made for, and is sent only under that account, checked
//      right before each send. Another account's share, and a share kept before stamping (no `account`), is parked: it
//      is kept, never shown or sent, until its account returns (KEPT_MOST_MS, like any share). With no account on the
//      page a share is sent once and kept nowhere.

import { postJson } from './api';
import { notify } from '../../parts/ui/show/coss/notifications';
import { reasonOf } from './failure';
import { keptAccount } from '../../parts/ui/show/page-storage/page-storage';
import { inOneTab } from './tab-leader';

/** The lock the tab that sends kept shares again holds while it does; other tabs skip that tick. */
export const DRAIN_LOCK = 'trillion-share-outbox-drain';

export type DeadLetter = { request_key: string; body: Record<string, unknown>; let_go_at: number; said: string; account: string; path?: string; key_field?: string; meta?: Record<string, unknown> };
export type KeptShare = { request_key: string; body: Record<string, unknown>; kept_at: number; account?: string; path?: string; key_field?: string; meta?: Record<string, unknown> };
/** Where a kept write goes and the body field its key travels in; a share names neither. */
export type Route = { path: string; key_field: string };
/** What the account answered: shares sent to places answer `delivered`; a share the account kept at its edge answers `queued`. */
export type DeliverAnswer = { delivered?: { id: string; label: string; said?: string }[]; stopped_at?: { label: string; error: string } | null; handoff_ids?: string[];
  queued?: boolean; words?: string; request_key?: string; code?: string;
  presentation?: { state: 'unavailable' | 'withdrawn'; code: string; fields: Record<string, string> }; connected?: { pursuits?: { id: string; title: string }[]; people?: { id: string; title?: string }[]; records?: { id: string; title?: string }[] } };
/** `sent`: the account answered it. `kept`: this device has it and will send it again. */
export type Delivered = { state: 'sent'; answer: DeliverAnswer } | { state: 'kept'; answer: null };

export const DELIVER_PATH = '/work/api/share-destinations/deliver';
export const STORAGE_KEY = 'trillion-share-outbox';
export const DEAD_STORAGE_KEY = 'trillion-share-dead-letters';
/** The most dead letters a device keeps, newest first. */
export const DEAD_MOST = 20;
/** How often a kept share is sent again while the page is open. */
export const RETRY_EVERY_MS = 60_000;
/** A share that could not be sent in this long is let go. */
export const KEPT_MOST_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether sending the same request again could succeed: it never got through, the account was busy or broke, or the session needs signing in again. */
export function retryable(error: unknown): boolean {
  const failure = error as { unreached?: boolean; status?: number; name?: string } | null;
  if (failure?.unreached === true) return true;
  if (error instanceof TypeError) return true;
  const status = failure?.status;
  return typeof status === 'number' && (status === 0 || status >= 500 || status === 408 || status === 429 || status === 401);
}

type Options = {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  post?: (path: string, body: unknown) => Promise<DeliverAnswer>;
  now?: () => number;
  /** Told when a kept share is refused in words and let go, or let go for age. */
  onLetGo?: (body: Record<string, unknown>, said: string) => void;
  /** The signed-in account on this page (its name on the device), or null where none is signed in. */
  account?: () => string | null;
};

export function createShareOutbox({ storage = null, post = (path, body) => postJson<DeliverAnswer>(path, body), now = Date.now, onLetGo = () => {},
  account = () => keptAccount()?.store ?? null }: Options = {}) {
  let held: KeptShare[] = [];
  const listeners = new Set<() => void>();
  const sending = new Set<string>();
  let draining: Promise<number> | null = null;

  const read = (): KeptShare[] => {
    try {
      const saved = storage?.getItem(STORAGE_KEY);
      if (saved) { const rows = JSON.parse(saved); if (Array.isArray(rows)) held = rows.filter(row => row && typeof row.request_key === 'string' && row.body); }
    } catch { /* the memory copy stands */ }
    return held;
  };
  const write = (rows: KeptShare[]) => {
    held = rows;
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(rows)); } catch { /* held in memory */ }
    listeners.forEach(listener => listener());
  };
  let dead: DeadLetter[] = [];
  const readDead = (): DeadLetter[] => {
    try {
      const saved = storage?.getItem(DEAD_STORAGE_KEY);
      if (saved) { const rows = JSON.parse(saved); if (Array.isArray(rows)) dead = rows.filter(row => row && typeof row.request_key === 'string' && row.body); }
    } catch { /* the memory copy stands */ }
    return dead;
  };
  const writeDead = (rows: DeadLetter[]) => {
    dead = rows.slice(-DEAD_MOST);
    try { storage?.setItem(DEAD_STORAGE_KEY, JSON.stringify(dead)); } catch { /* held in memory */ }
    listeners.forEach(listener => listener());
  };
  /** Moves a let-go share to the dead letters, when it was made under a signed-in account. */
  const bury = (share: KeptShare, said: string) => {
    if (!share.account) return;
    writeDead([...readDead().filter(row => row.request_key !== share.request_key), { request_key: share.request_key, body: share.body, let_go_at: now(), said, account: share.account,
      ...(share.path ? { path: share.path, key_field: share.key_field } : {}), ...(share.meta ? { meta: share.meta } : {}) }]);
  };
  const keep = (share: KeptShare) => write([...read().filter(row => row.request_key !== share.request_key), share]);
  const drop = (requestKey: string) => write(read().filter(row => row.request_key !== requestKey));

  /** Sends one kept share; true when it left the outbox, false when it stays. A refusal in words lets it go (and throws it). */
  async function attempt(share: KeptShare): Promise<{ left: boolean; answer: DeliverAnswer | null }> {
    sending.add(share.request_key);
    try {
      const answer = await post(share.path ?? DELIVER_PATH, { ...share.body, [share.key_field ?? 'request_key']: share.request_key });
      drop(share.request_key);
      return { left: true, answer };
    } catch (error) {
      if (retryable(error)) return { left: false, answer: null };
      drop(share.request_key);
      bury(share, reasonOf(error));
      throw error;
    } finally { sending.delete(share.request_key); }
  }

  return {
    /**
     * Keeps the request on this device, then sends it. Answers `sent` with what the account said (which may be `queued`)
     * or `kept` when the account could not be reached; a refusal in words is thrown and the share is let go.
     */
    async deliver(body: Record<string, unknown>, route?: Route, meta?: Record<string, unknown>): Promise<Delivered> {
      const keyField = route?.key_field ?? 'request_key';
      const request_key = typeof body[keyField] === 'string' && body[keyField] ? body[keyField] as string : crypto.randomUUID();
      const signedIn = account();
      const share: KeptShare = { request_key, body: { ...body, [keyField]: request_key }, kept_at: now(), ...(route ?? {}), ...(meta ? { meta } : {}), ...(signedIn ? { account: signedIn } : {}) };
      if (signedIn) keep(share);
      const { left, answer } = await attempt(share);
      return left && answer ? { state: 'sent', answer } : { state: 'kept', answer: null };
    },
    /** Sends everything kept again, oldest first, each with its own key; answers how many left. One round at a time. */
    drain(): Promise<number> {
      draining ??= (async () => {
        let left = 0;
        for (const share of [...read()].sort((a, b) => a.kept_at - b.kept_at)) {
          if (sending.has(share.request_key)) continue;
          // Another account's share, and one kept before stamping, is parked: never sent under the account now signed in.
          // It is let go for age like any share, but silently, since no one on this page can be told about it.
          if (share.account !== account()) { if (now() - share.kept_at > KEPT_MOST_MS) drop(share.request_key); continue; }
          if (now() - share.kept_at > KEPT_MOST_MS) { drop(share.request_key); bury(share, 'It could not be sent for too long.'); onLetGo(share.body, ''); continue; }
          try {
            const result = await attempt(share);
            if (result.left && result.answer?.stopped_at) {
              const said = `${result.answer.stopped_at.label ?? 'One place'} did not take it: ${result.answer.stopped_at.error ?? 'it refused'}`.slice(0, 300);
              bury(share, said);
              onLetGo(share.body, said);
            }
            else if (result.left) left += 1;
            else break;
          } catch (error) { onLetGo(share.body, reasonOf(error)); }
        }
        return left;
      })().finally(() => { draining = null; });
      return draining;
    },
    /** Sends one kept write again now, with its own key: `sent` when the account answered, `kept` when it still cannot be reached, `gone` when none is kept under the key. */
    async resend(requestKey: string): Promise<'sent' | 'kept' | 'gone'> {
      const share = this.list().find(row => row.request_key === requestKey);
      if (!share) return 'gone';
      if (sending.has(requestKey)) return 'kept';
      return (await attempt(share)).left ? 'sent' : 'kept';
    },
    /** Lets one kept write go without sending it; true when one was kept under the key. */
    cancel(requestKey: string): boolean {
      if (!this.list().some(row => row.request_key === requestKey)) return false;
      drop(requestKey);
      return true;
    },
    /** The shares let go on this account, newest first, each with the words it was let go in. */
    deadLetters: (): DeadLetter[] => readDead().filter(row => row.account === account()).sort((a, b) => b.let_go_at - a.let_go_at),
    /** Sends a dead letter again as a new share (a new request_key); answers what deliver answers. */
    async sendAgain(requestKey: string): Promise<Delivered> {
      const letter = readDead().find(row => row.request_key === requestKey && row.account === account());
      if (!letter) throw new Error('That share is no longer waiting here.');
      writeDead(readDead().filter(row => row.request_key !== requestKey));
      const body = { ...letter.body };
      delete body[letter.key_field ?? 'request_key'];
      return this.deliver(body, letter.path && letter.key_field ? { path: letter.path, key_field: letter.key_field } : undefined, letter.meta);
    },
    discardDead(requestKey: string) { writeDead(readDead().filter(row => row.request_key !== requestKey)); },
    count: () => read().filter(share => share.account === account()).length,
    list: () => read().filter(share => share.account === account()),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

const localStorageOrNull = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The page's one outbox. */
export const shareOutbox = createShareOutbox({
  storage: localStorageOrNull(),
  onLetGo: (_body, said) => { if (said) notify(said, { kind: 'error' }); },
});

let started = false;
/** Sends kept shares again now, when the browser comes back online, when the window gets focus and every minute. Once per page. */
export function keepSendingShares(outbox = shareOutbox, target: Pick<Window, 'addEventListener'> | null = typeof window === 'undefined' ? null : window): void {
  if (started && outbox === shareOutbox) return;
  if (outbox === shareOutbox) started = true;
  const again = () => { void inOneTab(DRAIN_LOCK, async () => { await outbox.drain(); }); };
  again();
  target?.addEventListener('online', again);
  target?.addEventListener('focus', again);
  // Another tab changed the outbox: this one lists it afresh.
  target?.addEventListener('storage', event => { if ((event as StorageEvent).key === STORAGE_KEY) again(); });
  setInterval(again, RETRY_EVERY_MS);
}

if (typeof window !== 'undefined') keepSendingShares();
