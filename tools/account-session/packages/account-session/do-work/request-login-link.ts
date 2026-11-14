import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const LOGIN_LINK_TARGET = 'account-session.login-link';

export async function requestAccountPortalLoginLink(
  email: string,
  returnPath = '/account',
) {
  const reply = await sendRequestToBitfieldTarget({
    target: LOGIN_LINK_TARGET,
    payload: { email, returnPath },
  });
  const body = JSON.parse(new TextDecoder().decode(reply.payload)) as {
    accepted?: unknown;
  };
  if (body.accepted !== true) {
    throw new Error('Could not send the sign-in link.');
  }
  return body as { accepted: true };
}
