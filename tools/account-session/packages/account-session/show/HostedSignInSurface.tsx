import React from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPanel } from './LoginPanel';
import { readAccountSession } from '../read-data/read-session';
import { currentBrowserSessionAccessKey, currentPresenterBrowserSessionId } from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';

const BASIS_HEADER = 'X-Bitfield-Running-Command-List-Basis';

async function requestLoginLink(email: string): Promise<void> {
  let boot: Response;
  try {
    boot = await fetch('/boot?for=sign-in', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error('The sign-in service is unavailable. Please try again.');
  }
  if (!boot.ok) throw new Error('The sign-in service is unavailable. Please try again.');
  const targets: unknown = await boot.json();
  const basis = Array.isArray(targets) && typeof targets[0]?.running_command_list_basis === 'string'
    ? targets[0].running_command_list_basis
    : null;
  if (!basis) throw new Error('The sign-in service is unavailable. Please try again.');
  let response: Response;
  try {
    response = await fetch('/target/account-session.login-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BASIS_HEADER]: basis },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        browser_id: currentPresenterBrowserSessionId(),
        session_access_key: currentBrowserSessionAccessKey(),
        email,
        redirect_to: new URL('/', window.location.origin).toString(),
        returnPath: '/',
      }),
    });
  } catch {
    throw new Error('We couldn’t confirm whether the link was sent. Check your inbox before trying again.');
  }
  const reply = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error('We couldn’t send the sign-in link. Please try again.');
  }
  if (reply?.accepted !== true) {
    throw new Error('We couldn’t confirm whether the link was sent. Check your inbox before trying again.');
  }
}

function HostedSignInSurface() {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  return <LoginPanel
    appName={document.title || 'this app'}
    actionError={error}
    actionPending={pending}
    session={readAccountSession(null)}
    showSignup={false}
    onRequestLoginLink={async (email) => {
      setError(null);
      setPending(true);
      try {
        await requestLoginLink(email);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'We couldn’t send the sign-in link. Please try again.');
        throw cause;
      } finally {
        setPending(false);
      }
    }}
  />;
}

const mount = document.getElementById('root');
if (!mount) throw new Error('The sign-in surface has no mount.');
createRoot(mount).render(<HostedSignInSurface />);
