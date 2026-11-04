// parts/account-session/do-work/read-current-browser-session.ts
//
// PURPOSE
//   The signed-in account for the browser this code runs in, with no argument:
//   it reads this browser's own id and asks readAccountPortalSession whether an
//   active session belongs to it. A screen that shows the person's own details
//   (an account profile, say) uses this to tie what it saves to the signed-in
//   account instead of to a device-local identity.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Concurrent callers share one read: a screen that asks twice while a read
//      is in flight waits for the same answer instead of sending a second one.
//   2. An unchanged session comes back as the SAME object. Screens re-read on
//      focus and visibility because a session can be revoked while a tab sits
//      in the background, and a fresh object every time would make each re-read
//      look like a change and redraw the whole screen.
//   3. A failed read resolves to null (signed out as far as the screen knows)
//      and hands the error to the caller's onError; it never throws into a
//      render.
import { readAccountPortalSession } from '../read-data/read-browser-session';
import { currentLogBrowserSessionBrowserId } from './browser-session-browser-id';

export type CurrentBrowserSession = Awaited<ReturnType<typeof readAccountPortalSession>>;

type SharedRead = { browserId: string; promise: Promise<CurrentBrowserSession> };
type SettledSession = { text: string; value: CurrentBrowserSession };

const SHARED_READ = Symbol.for('trillion.account-session.current-browser-session-read');
const SETTLED_SESSION = Symbol.for('trillion.account-session.current-browser-session-settled');

function slots(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

function keepIdentityWhenUnchanged(value: CurrentBrowserSession): CurrentBrowserSession {
  const text = JSON.stringify(value ?? null);
  const previous = slots()[SETTLED_SESSION] as SettledSession | undefined;
  if (previous && previous.text === text) return previous.value;
  slots()[SETTLED_SESSION] = { text, value } satisfies SettledSession;
  return value;
}

function readOnce(browserId: string): Promise<CurrentBrowserSession> {
  const existing = slots()[SHARED_READ] as SharedRead | undefined;
  if (existing?.browserId === browserId) return existing.promise;
  const promise = readAccountPortalSession({ browserId, nowMs: Date.now() }).then(keepIdentityWhenUnchanged);
  const entry: SharedRead = { browserId, promise };
  slots()[SHARED_READ] = entry;
  void promise.finally(() => {
    if (slots()[SHARED_READ] === entry) delete slots()[SHARED_READ];
  }).catch(() => undefined);
  return promise;
}

export async function readAccountPortalBrowserSession(onError?: (error: unknown) => void): Promise<CurrentBrowserSession> {
  try {
    return await readOnce(currentLogBrowserSessionBrowserId());
  } catch (error) {
    onError?.(error);
    return null;
  }
}
