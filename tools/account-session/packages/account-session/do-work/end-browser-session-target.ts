import { readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { clearAccountPortalSessionCookie } from './write-browser-session';
import { revokeCurrentLogBrowserSession } from './current-log-browser-session';
import { readHostedAccountAuthority } from './hosted-account-authority';
import { clearDesktopAccountSession } from './desktop-account-session';

type EndBrowserSessionInput = {
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

export async function endBrowserSessionTarget(
  input: EndBrowserSessionInput = {},
  context?: BitfieldRuntimeContext,
) {
  const hosted = await readHostedAccountAuthority();
  if (hosted) await clearDesktopAccountSession(hosted, readRequiredString(input.browser_id ?? input.browserId, 'browser_id'), context, undefined, input.session_access_key);
  await revokeCurrentLogBrowserSession({
    browserId: readRequiredString(input.browser_id ?? input.browserId, 'browser_id'),
    nowMs: readTrustedRuntimeClockMs(context),
  });
  return {
    ok: true,
    browserEffects: {
      cookies: [clearAccountPortalSessionCookie()],
    },
  };
}
