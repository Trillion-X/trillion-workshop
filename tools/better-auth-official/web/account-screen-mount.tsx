// tools/better-auth-official/web/account-screen-mount.tsx
//
// PURPOSE
//   The person's account as a Workshop screen module: the one file a screen row names (`screen.module.entry`), whose
//   `mount(element, props)` is the module contract (web/src/workspace/tool-screen.tsx). It draws the person's name, email and
//   how they sign in, each row with the page that changes it, and Delete my account. The answers come from the sign-in's own
//   Better Auth routes (the same ones the sign-in's /account page reads) and the words are the sign-in's own
//   (pages/words.json). No page of the sign-in is embedded.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account is read from the sign-in's routes on each draw; nothing about it is kept here.
//   2. Deleting asks for the password when the account has one. A wrong password keeps the account and says so; any other
//      failure keeps the account and says that the account could not be deleted.
//   3. The only change this screen makes is the delete. Every other row links to the sign-in page that changes it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Button, Input, Text, mountReactSurface } from '../../ui';
import words from '../pages/words.json';

type Account = { id?: string; providerId: string };
type Session = { user: { name?: string | null; email: string; twoFactorEnabled?: boolean | null } } | null;
type Loaded = { session: NonNullable<Session>; passkeys: number; accounts: Account[] };
type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; account: Loaded };

const AUTH = '/api/auth';

async function read<T>(path: string): Promise<T> {
  const answer = await fetch(`${AUTH}${path}`, { cache: 'no-store' });
  if (!answer.ok) throw new Error(`The sign-in answered ${answer.status}.`);
  return answer.json() as Promise<T>;
}

async function loadAccount(): Promise<Loaded | null> {
  const session = await read<Session>('/get-session');
  if (!session) return null;
  const [passkeys, accounts] = await Promise.all([read<unknown[]>('/passkey/list-user-passkeys'), read<Account[]>('/list-accounts')]);
  return { session, passkeys: passkeys.length, accounts };
}

/** Deletes the account. Null when it is gone; otherwise the words for why it is kept. */
async function deleteAccount(password: string | null): Promise<string | null> {
  const answer = await fetch(`${AUTH}/delete-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(password === null ? {} : { password }),
  });
  if (answer.ok) { location.assign('/'); return null; }
  const body = (await answer.json().catch(() => ({}))) as { code?: string };
  return body.code === 'INVALID_PASSWORD' ? words.account_wrong_password : words.account_delete_failed;
}

function Row({ heading, detail, change }: { heading: string; detail: string; change?: { href: string; text: string } }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--border-primary)] py-3">
      <div className="grid min-w-0 gap-1">
        <Text weight="medium">{heading}</Text>
        <Text color="muted">{detail}</Text>
      </div>
      {change ? <Button variant="ghost" size="sm" onClick={() => location.assign(change.href)}>{change.text}</Button> : null}
    </div>
  );
}

function passkeyWords(count: number): string {
  if (count === 0) return words.account_passkeys_none;
  if (count === 1) return words.account_passkeys_one;
  return words.account_passkeys_some.replace('{count}', String(count));
}

function AccountScreen() {
  const [state, setState] = React.useState<State>({ status: 'loading' });
  const [deleting, setDeleting] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [kept, setKept] = React.useState<string | null>(null);

  React.useEffect(() => {
    let gone = false;
    loadAccount().then(
      account => { if (!gone) setState(account ? { status: 'ready', account } : { status: 'failed' }); },
      () => { if (!gone) setState({ status: 'failed' }); },
    );
    return () => { gone = true; };
  }, []);

  if (state.status === 'loading') return <Text color="muted">{words.account_loading}</Text>;
  if (state.status === 'failed') return <Text color="muted">{words.account_failed}</Text>;

  const { session, passkeys, accounts } = state.account;
  const hasPassword = accounts.some(account => account.providerId === 'credential');
  const others = accounts.filter(account => account.providerId !== 'credential').map(account => account.providerId.charAt(0).toUpperCase() + account.providerId.slice(1));
  const name = session.user.name?.trim();

  return (
    <div className="grid w-full max-w-2xl gap-4">
      <Text variant="title">{words.account_heading}</Text>
      <Text color="muted">{words.account_intro}</Text>
      <Row heading={words.account_name} detail={name || words.account_name_unset} change={{ href: '/sign-in/your-name', text: words.account_change }} />
      <Row heading={words.account_email} detail={session.user.email} change={{ href: '/sign-in/change-email', text: words.account_change }} />
      <Row heading={words.account_passkeys} detail={passkeyWords(passkeys)} change={{ href: '/sign-in/add-passkey', text: words.account_add_passkey }} />
      <Row heading={words.account_authenticator} detail={session.user.twoFactorEnabled ? words.account_on : words.account_off} />
      <Row heading={words.account_password} detail={hasPassword ? words.account_password_set : words.account_password_unset} />
      <Row heading={words.account_other} detail={others.length ? others.join(', ') : words.account_other_none} />
      {deleting ? (
        <div className="grid gap-3 pt-2">
          <Text weight="medium">{words.account_delete_title}</Text>
          <Text color="muted">{words.account_delete_confirm}</Text>
          {hasPassword ? (
            <Input type="password" aria-label={words.account_password} value={password} placeholder={words.account_password_needed}
              onChange={event => setPassword(event.target.value)} />
          ) : null}
          {kept ? <Text color="muted">{kept}</Text> : null}
          <div className="flex gap-2">
            <Button variant="danger" onClick={async () => {
              if (hasPassword && !password) { setKept(words.account_password_needed); return; }
              setKept(await deleteAccount(hasPassword ? password : null));
            }}>{words.account_delete}</Button>
            <Button variant="ghost" onClick={() => { setDeleting(false); setKept(null); setPassword(''); }}>{words.account_delete_keep}</Button>
          </div>
        </div>
      ) : (
        <div className="pt-2">
          <Button variant="danger" onClick={() => setDeleting(true)}>{words.account_delete}</Button>
        </div>
      )}
    </div>
  );
}

export function mount(element: HTMLElement, _props: Record<string, unknown> = {}) {
  return mountReactSurface(element, <AccountScreen />);
}
