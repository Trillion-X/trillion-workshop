import { readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { readAccountPortalSession } from '../../../read-data/read-browser-session';
import { readHostedAccountAuthority } from './hosted-account-authority';
import { readDesktopAccountSession } from './desktop-account-session';

type BrowserSessionTargetInput = {
  browser_id?: unknown;
  browserId?: unknown;
  session_access_key?: unknown;
};

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export async function readBrowserSessionTarget(
  input: BrowserSessionTargetInput = {},
  context?: BitfieldRuntimeContext,
) {
  const hosted = await readHostedAccountAuthority();
  if (hosted) return readDesktopAccountSession(hosted, readRequiredString(input.browser_id ?? input.browserId, 'browser_id'), context, undefined, input.session_access_key);
  const session = await readAccountPortalSession({
    browserId: readRequiredString(input.browser_id ?? input.browserId, 'browser_id'),
    nowMs: readTrustedRuntimeClockMs(context),
  });
  return {
    session: session
      ? {
          accountId: session.accountId,
          accountIdHash: session.accountIdHash,
          email: session.email,
          emailConfirmed: session.emailConfirmed,
          signedAccountSessionProofId: session.signedAccountSessionProofId,
          status: session.status,
          authority: session.authority,
        }
      : null,
  };
}
