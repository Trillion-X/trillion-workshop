import {
  createTrustedRuntimeIdMinter,
  readTrustedRuntimeClockMs,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { completeReturningLogin } from './complete-returning-login';
import { accountAccessSessionCookie } from './write-browser-session';
import { approveDesktopLoginHandoff } from './desktop-login-handoff';

type CompleteReturningLoginTargetInput = {
  token?: unknown;
};

export async function completeReturningLoginTarget(
  input: CompleteReturningLoginTargetInput,
  context?: BitfieldRuntimeContext,
) {
  const nowMs = readTrustedRuntimeClockMs(context);
  const completed = await completeReturningLogin(
    typeof input.token === 'string' ? input.token : undefined,
    Math.floor(nowMs / 1000),
  );
  if (completed.desktopHandoff) {
    await approveDesktopLoginHandoff(input.token as string, context);
    return { desktop_handoff: true, returnPath: '/app' };
  }
  return {
    ...completed,
    browserEffects: {
      cookies: [await accountAccessSessionCookie(completed.accountId, {
        mintId: createTrustedRuntimeIdMinter(context),
        nowMs,
      })],
    },
  };
}
