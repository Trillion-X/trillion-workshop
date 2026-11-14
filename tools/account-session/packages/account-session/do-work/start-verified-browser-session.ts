import {
  createTrustedRuntimeIdMinter,
  readTrustedRuntimeClockMs,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { issueAccountAccessSession } from './write-browser-session';
import { writeCurrentLogBrowserSession } from './current-log-browser-session';

type StartVerifiedBrowserSessionInput = {
  account_id?: unknown;
  accountId?: unknown;
  browser_id?: unknown;
  browserId?: unknown;
  email?: unknown;
};

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export async function startVerifiedBrowserSession(
  input: StartVerifiedBrowserSessionInput,
  context?: BitfieldRuntimeContext,
) {
  const accountId = readRequiredString(input.account_id ?? input.accountId, 'account_id');
  const browserId = readRequiredString(input.browser_id ?? input.browserId, 'browser_id');
  const email = typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null;
  const issued = await issueAccountAccessSession(accountId, {
    mintId: createTrustedRuntimeIdMinter(context),
    nowMs: readTrustedRuntimeClockMs(context),
  });
  const session = await writeCurrentLogBrowserSession({ accountId, browserId, email, session: issued.session });
  return {
    accountId,
    email,
    ok: true,
    session,
    browserEffects: {
      cookies: [issued.cookie],
    },
  };
}
