import type { AccountSessionProjection } from '../read-data/read-session';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  adoptVerifiedLegacyPresenterBrowserCredential,
  currentBrowserSessionAccessKey,
  currentPresenterBrowserSessionId,
  forgetUnverifiedLegacyPresenterBrowserCredential,
  unverifiedLegacyPresenterBrowserCredential,
} from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';

type SharedRead = { browserId: string; promise: Promise<unknown> };
const SHARED_READ = Symbol.for('bitfield.account-session.browser-session-read');

function sharedReads(): Record<PropertyKey, SharedRead | undefined> {
  return globalThis as unknown as Record<PropertyKey, SharedRead | undefined>;
}

/**
 * The same session, read twice, is the SAME value and must be handed back as the
 * same object.
 *
 * Surfaces re-read this whenever the tab is focused or becomes visible, which is
 * correct: a session can be revoked while a tab sits in the background. But a
 * decoded reply is a fresh object every time, so an unchanged session still
 * arrived as a new identity, every consumer's state changed, and the whole tree
 * re-rendered and remounted its player. Returning to a tab looked like the page
 * reloading itself, on our surfaces only, because only our surfaces re-read.
 *
 * Holding the last value and returning it verbatim when the bytes match makes an
 * unchanged session cost nothing to observe, so the re-read stays as frequent as
 * safety wants while the surface stays perfectly still.
 */
type SettledSession = { text: string; value: unknown };
const SETTLED_SESSION = Symbol.for('bitfield.account-session.browser-session-settled');

function settledSessions(): Record<PropertyKey, SettledSession | undefined> {
  return globalThis as unknown as Record<PropertyKey, SettledSession | undefined>;
}

function sessionKeepingItsIdentityWhenUnchanged(text: string, value: unknown): unknown {
  const settled = settledSessions();
  const previous = settled[SETTLED_SESSION];
  if (previous && previous.text === text) return previous.value;
  settled[SETTLED_SESSION] = { text, value };
  return value;
}

function readBrowserSessionOnce(browserId: string): Promise<unknown> {
  const shared = sharedReads();
  const existing = shared[SHARED_READ];
  if (existing?.browserId === browserId) return existing.promise;
  const promise = (async () => {
    const read = async (id: string, accessKey: string) => {
      const reply = await sendRequestToBitfieldTarget({ target: 'account-session.browser-session', payload: {
        browser_id: id,
        session_access_key: accessKey,
      } });
      const body = JSON.parse(new TextDecoder().decode(reply.payload));
      return body.session ?? null;
    };
    let session = await read(browserId, currentBrowserSessionAccessKey());
    if (session == null) {
      const legacy = unverifiedLegacyPresenterBrowserCredential();
      if (legacy) {
        const olderSession = await read(legacy.browserId, legacy.accessKey);
        if (olderSession != null) {
          adoptVerifiedLegacyPresenterBrowserCredential(legacy);
          session = olderSession;
        } else {
          forgetUnverifiedLegacyPresenterBrowserCredential();
        }
      }
    } else {
      forgetUnverifiedLegacyPresenterBrowserCredential();
    }
    return sessionKeepingItsIdentityWhenUnchanged(JSON.stringify(session ?? null), session);
  })();
  const entry = { browserId, promise };
  shared[SHARED_READ] = entry;
  void promise.finally(() => {
    if (shared[SHARED_READ] === entry) delete shared[SHARED_READ];
  }).catch(() => undefined);
  return promise;
}

/**
 * The browser's own read of its session. Only SURFACE entries reach this module
 * (`account-session`, `account-session-surface`, `magic-link-login`), and a surface's clock is
 * an input the log records rather than a derivation of it, so reading it here is the browser
 * telling the truth about when it asked. Every DERIVATION path takes `nowMs` from the runtime.
 */
export async function readAccountPortalBrowserSession(onError?: (error: unknown) => void) {
  try {
    return await readBrowserSessionOnce(currentPresenterBrowserSessionId());
  } catch (error) {
    onError?.(error);
    return null;
  }
}
