import {
  createTrustedRuntimeIdMinter,
  readTrustedRuntimeClockMs,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { startReturningLogin } from './start-returning-login';
import { readHostedAccountAuthority } from './hosted-account-authority';
import { requestDesktopAccountLogin } from './desktop-account-session';
import { readDesktopLoginChallenge } from './desktop-login-handoff';

type LoginRequestBody = {
  browser_id?: unknown;
  email?: unknown;
  email_message?: unknown;
  requestId?: unknown;
  returnPath?: unknown;
  redirect_to?: unknown;
  desktop_handoff?: unknown;
  session_access_key?: unknown;
};

export function redirectParts(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return {};
  const parsed = new URL(value);
  return {
    publicUrl: parsed.origin,
  };
}

/**
 * A caller is handled as a separate app asking this authority to sign someone
 * in only when it presents a handoff challenge. That is the thing only such an
 * app has.
 *
 * The signal used to be "did the caller send a session access key", on the
 * reasoning that the desktop client owns one and omits it when calling the
 * authority. But the browser sign-in surface sends one too, so the hosted app
 * treated its own visitor as another app: it made an HTTP request to itself,
 * minted a handoff, and mailed a link that ended at "open the desktop app"
 * instead of signing the person in where they already were.
 */
export function shouldUseHostedAccountClient(
  hosted: unknown,
  input: { desktop_handoff?: unknown },
) {
  return hosted !== null && input.desktop_handoff !== undefined;
}

export async function sendLoginLinkTarget(
  input: LoginRequestBody,
  context?: BitfieldRuntimeContext,
) {
  const hosted = await readHostedAccountAuthority();
  // The local client owns session_access_key and deliberately omits it when it
  // calls the hosted authority. That omission is the trust-preserving routing
  // boundary: the hosted target must mint and deliver the link, never recurse
  // into the desktop-client state machine on the authority runtime itself.
  if (shouldUseHostedAccountClient(hosted, input)) {
    return requestDesktopAccountLogin(hosted!, input, context);
  }
  const redirected = redirectParts(input.redirect_to);
  const mintId = createTrustedRuntimeIdMinter(context);
  return startReturningLogin({
    ...(hosted === null ? {} : { allowedPublicOrigin: hosted.origin }),
    browserId: input.browser_id,
    email: input.email,
    emailMessage: input.email_message,
    requestId: typeof input.requestId === 'string' ? input.requestId : mintId(),
    returnPath: input.returnPath ?? redirected.returnPath,
    publicUrl: input.desktop_handoff === undefined ? redirected.publicUrl : undefined,
    ...(input.desktop_handoff === undefined ? {} : { desktopHandoff: readDesktopLoginChallenge(input.desktop_handoff) }),
  }, {
    mintId,
    nowSeconds: Math.floor(readTrustedRuntimeClockMs(context) / 1000),
  });
}
