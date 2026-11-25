// tools/better-auth-official/web/account-screen-mount.tsx
//
// PURPOSE
//   The person's account as a Workshop screen module: the one file a screen row names (`screen.module.entry`), whose
//   `mount(element, props)` is the module contract (web/src/workspace/tool-screen.tsx). It reads the account from the
//   sign-in's own Better Auth routes (the same ones the sign-in's /account page reads: get-session, list-accounts, the
//   passkey list and list-sessions), draws it with the shared guide from the description web/account-guide.ts builds, and
//   answers the guide's actions with the sign-in's own routes: remove a passkey, sign out of one other browser or of every
//   other one, and delete the account. No page of the sign-in is embedded.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The account is read from the sign-in's routes on each draw and after each change; nothing about it is kept here.
//   2. Deleting asks in place, and for the password when the account has one. A wrong password keeps the account and says
//      so; any other failure keeps the account and says that it could not be deleted.
//   3. A refused change leaves the account as the sign-in says it is and says so under the part it was made in.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { ScreenState } from '../../ui/show/screen-state';
import { Guide, type GuideAction, type GuideValues } from '../../ui/show/coss/guide';
import { ACCOUNT_ACTIONS, accountGuide, signInWords as words, screenWords, type AccountGuideInput, type Passkey, type SignInAccount, type SignedInSession, type AccountUser } from './account-guide';

const AUTH = '/api/auth';

type Session = { user: AccountUser; session?: { token?: string } } | null;
type Read = Omit<AccountGuideInput, 'problem' | 'here'>;
type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; read: Read };

async function read<T>(path: string): Promise<T> {
  const answer = await fetch(`${AUTH}${path}`, { cache: 'no-store' });
  if (!answer.ok) throw new Error(`The sign-in answered ${answer.status}.`);
  return answer.json() as Promise<T>;
}

/** The sessions list, or why it is not shown: Better Auth shows it only to a sign-in made within its fresh window (403). */
async function readSessions(): Promise<AccountGuideInput['sessions']> {
  const answer = await fetch(`${AUTH}/list-sessions`, { cache: 'no-store' }).catch(() => null);
  if (answer?.status === 403) return 'not-fresh';
  if (!answer?.ok) return 'failed';
  return answer.json() as Promise<SignedInSession[]>;
}

async function loadAccount(): Promise<Read | null> {
  const session = await read<Session>('/get-session');
  if (!session) return null;
  const [passkeys, accounts, sessions] = await Promise.all([read<Passkey[]>('/passkey/list-user-passkeys'), read<SignInAccount[]>('/list-accounts'), readSessions()]);
  return { user: session.user, accounts, passkeys, sessions, currentToken: session.session?.token ?? null };
}

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
  const answer = await fetch(`${AUTH}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const said = (await answer.json().catch(() => ({}))) as { code?: string };
  return { ok: answer.ok, code: said.code };
}

/** Which sign-in route each kind of action goes to, with the body it sends there. */
const ROUTES: Record<string, (body: Record<string, unknown>, values: GuideValues) => [string, Record<string, unknown>]> = {
  [ACCOUNT_ACTIONS.removePasskey]: body => ['/passkey/delete-passkey', { id: body.id }],
  [ACCOUNT_ACTIONS.endSession]: body => ['/revoke-session', { token: body.token }],
  [ACCOUNT_ACTIONS.endOtherSessions]: () => ['/revoke-other-sessions', {}],
  [ACCOUNT_ACTIONS.deleteAccount]: (_body, values) => ['/delete-user', typeof values.password === 'string' && values.password ? { password: values.password } : {}],
};
const SECTION_OF: Record<string, string> = { [ACCOUNT_ACTIONS.removePasskey]: 'passkeys', [ACCOUNT_ACTIONS.endSession]: 'sessions', [ACCOUNT_ACTIONS.endOtherSessions]: 'sessions', [ACCOUNT_ACTIONS.deleteAccount]: 'delete' };

function AccountScreen() {
  const [state, setState] = React.useState<State>({ status: 'loading' });
  const [problem, setProblem] = React.useState<AccountGuideInput['problem']>(null);

  const reload = React.useCallback(() => loadAccount().then(
    found => setState(found ? { status: 'ready', read: found } : { status: 'failed' }),
    () => setState({ status: 'failed' }),
  ), []);
  React.useEffect(() => { void reload(); }, [reload]);

  const onAction = React.useCallback(async (action: GuideAction, values: GuideValues) => {
    const kind = action.send?.path ?? '';
    const route = ROUTES[kind];
    if (!route) return;
    const deleting = kind === ACCOUNT_ACTIONS.deleteAccount;
    if (deleting && action.send?.with_fields && !values.password) { setProblem({ section: 'delete', text: words.account_password_needed }); return; }
    const [path, body] = route(action.send?.body ?? {}, values);
    const done = await post(path, body);
    if (!done.ok) {
      const text = deleting ? (done.code === 'INVALID_PASSWORD' ? words.account_wrong_password : words.account_delete_failed) : screenWords.failed;
      setProblem({ section: SECTION_OF[kind], text });
      throw new Error(text);
    }
    setProblem(null);
    if (deleting) { location.assign('/'); return; }
    await reload();
  }, [reload]);

  if (state.status === 'loading') return <ScreenState state={{ status: 'loading', label: words.account_loading }} />;
  if (state.status === 'failed') return <ScreenState state={{ status: 'failed', title: words.account_failed, retry: { label: screenWords.try_again, run: () => { setState({ status: 'loading' }); void reload(); } } }} />;
  const description = accountGuide({ ...state.read, problem, here: location.pathname + location.search });
  return (
    <ErrorBoundary zoneName="account">
      <Guide description={description} onAction={onAction} />
    </ErrorBoundary>
  );
}

export function mount(element: HTMLElement, _props: Record<string, unknown> = {}) {
  return mountReactSurface(element, <AccountScreen />);
}
