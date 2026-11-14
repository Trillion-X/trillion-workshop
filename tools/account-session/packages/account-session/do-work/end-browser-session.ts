import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { currentBrowserSessionAccessKey, currentPresenterBrowserSessionId } from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';

export interface AccountSessionWebActionResult {
  ok: true;
}

const END_BROWSER_SESSION_TARGET = 'account-session.end-browser-session';

function messageFromError(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'The account session action failed.';
}

export async function endAccountPortalWebSession(): Promise<AccountSessionWebActionResult> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: END_BROWSER_SESSION_TARGET,
      payload: { browser_id: currentPresenterBrowserSessionId(), session_access_key: currentBrowserSessionAccessKey() },
    });
    const body = JSON.parse(new TextDecoder().decode(reply.payload)) as {
      ok?: unknown;
    };
    if (body.ok !== true) throw new Error('The account session action failed.');
    return { ok: true };
  } catch (error) {
    throw new Error(messageFromError(error));
  }
}
