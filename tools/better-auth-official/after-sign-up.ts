// After a person's account is made, the business is told (settings.after_sign_up): a signed POST of {user_id, email, made_at,
// cookies} to a local address, made by Better Auth's after-create hook on the user (databaseHooks.user.create.after), so every way
// an account is made (an email and password, an email code, a passkey, a magic link) is told the same way, once, after the
// account's own transaction has committed. `cookies` holds only the cookies settings.after_sign_up.carried_cookies names, read
// from the request that made the account: what the person arrived with (a referral code), nothing else of the browser.
// The account stands whatever the call answers: a refused, failed or late call is logged and the sign-up answers as it would.
import { postSigned } from './before-delete-url.mjs';

export type AfterSignUpSettings = { url: string | null; secret: string | null; timeout_ms: number; carried_cookies: string[] };
type MadeUser = { id: string; email: string; createdAt?: Date | string | null };
type MakingRequest = { path?: string; headers?: Headers; request?: Request } | null | undefined;
type Log = { error: (line: string) => void };

// A carried value longer than this is left out (a referral code is a few dozen characters; nothing longer is a code).
export const CARRIED_VALUE_CHARACTERS = 256;
// An account an admin makes for someone else (the admin plugin's /admin/create-user) is not the new person's own arrival:
// the request's cookies are the admin's, so none are carried.
const MADE_FOR_SOMEONE_ELSE = /^\/admin\//;

/** The cookies of a Cookie header that `names` lists, each value at most CARRIED_VALUE_CHARACTERS; a name not sent is absent. */
export function cookiesNamed(header: string | null | undefined, names: string[]): Record<string, string> {
  const carried: Record<string, string> = {};
  if (!header || names.length === 0) return carried;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (names.includes(name) && !Object.hasOwn(carried, name) && value && value.length <= CARRIED_VALUE_CHARACTERS) carried[name] = value;
  }
  return carried;
}

/** The body the business receives for one made account. */
export function afterSignUpBody(user: MadeUser, making: MakingRequest, names: string[], now: Date = new Date()) {
  const ownArrival = !MADE_FOR_SOMEONE_ELSE.test(making?.path ?? '');
  const header = making?.headers?.get('cookie') ?? making?.request?.headers.get('cookie') ?? null;
  const made = user.createdAt ? new Date(user.createdAt) : now;
  return { user_id: user.id, email: user.email, made_at: made.toISOString(), cookies: ownArrival ? cookiesNamed(header, names) : {} };
}

/** Better Auth's after-create hook for the user, or null when settings.after_sign_up names no address (nothing is told). */
export function afterSignUpHook(after: AfterSignUpSettings | undefined, log: Log = console) {
  if (!after?.url || !after.secret) return null;
  const { url, secret, timeout_ms: timeoutMs, carried_cookies: names } = after;
  return async (user: MadeUser, making: MakingRequest): Promise<void> => {
    try {
      const answer = await postSigned(url, secret, afterSignUpBody(user, making, names), timeoutMs);
      if (!answer.ok) log.error(`the after-sign-up call for user ${user.id} answered HTTP ${answer.status}; the account stands`);
    } catch (error) {
      log.error(`the after-sign-up call for user ${user.id} failed: ${(error as Error).message}; the account stands`);
    }
  };
}
