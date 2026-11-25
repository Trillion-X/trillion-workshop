// tools/better-auth-official/web/account-guide.ts
//
// PURPOSE
//   The signed-in person's account as one guide description (tools/ui/show/coss/guide.tsx draws it): their name and email,
//   every way they sign in (email code, password, authenticator app, other accounts), their passkeys, where they are signed
//   in, and deleting the account. This is the first platform repository's Account & security screen's shape (src/account-screens.mjs): a
//   builder that turns what the sign-in answered into rows, and the shared guide that draws them. The words are the
//   sign-in's own (pages/words.json) and this screen's (account-guide-words.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: what the sign-in answered in, a description out. Nothing here reads or sends. An action that changes something
//      names its kind in `send.path` (an ACCOUNT_ACTIONS value) and its values in `send.body`; account-screen-mount.tsx
//      sends it to the sign-in's own route. A change made on a sign-in page is a link (`href`) to that page.
//   2. Only real facts: a status is drawn only from what was answered. A list the sign-in would not show (a sign-in older
//      than its fresh window) says how to see it, never that it is empty.
//   3. The password is typed into a secret box and sent once with the delete; it is never part of a description.
//   4. A session's token stays in the action that ends it; it is never drawn.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { GuideDescription, GuideRow, GuideSection } from '../../ui/show/coss/guide.tsx';
import signInWords from '../pages/words.json' with { type: 'json' };
import screenWords from './account-guide-words.json' with { type: 'json' };

export const ACCOUNT_ACTIONS = {
  removePasskey: 'remove-passkey',
  endSession: 'end-session',
  endOtherSessions: 'end-other-sessions',
  deleteAccount: 'delete-account',
} as const;

export type AccountUser = { name?: string | null; email: string; emailVerified?: boolean | null; twoFactorEnabled?: boolean | null };
export type SignInAccount = { providerId: string };
export type Passkey = { id: string; name?: string | null; createdAt?: string | null };
export type SignedInSession = { token: string; userAgent?: string | null; createdAt?: string | null; updatedAt?: string | null };

export type AccountGuideInput = {
  user: AccountUser;
  accounts: SignInAccount[];
  passkeys: Passkey[];
  /** The sign-in's list of sessions; 'not-fresh' when the sign-in shows it only to a recent sign-in; 'failed' when unread. */
  sessions: SignedInSession[] | 'not-fresh' | 'failed';
  /** This browser's own session token, to mark it and never offer to end it here. */
  currentToken: string | null;
  /** Words to say under one section after its action was refused ({ section: its id, text }). */
  problem?: { section: string; text: string } | null;
  /** The address the person comes back to after signing in again (the members page). */
  here: string;
};

const W = signInWords as Record<string, string>;
const S = screenWords;
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const named = (table: { match: string; name: string }[], text: string) => table.find(row => text.includes(row.match))?.name ?? null;

/** "Chrome on Mac" from a browser's user agent, by the words file's tables; a user agent they do not name is "A browser". */
export function deviceName(userAgent: string | null | undefined): string {
  const agent = userAgent ?? '';
  const browser = named(S.browsers, agent);
  const system = named(S.systems, agent);
  if (browser && system) return fill(S.device_name, { browser, system });
  return browser ?? system ?? S.unknown_device;
}

const providerName = (id: string) => (S.providers as Record<string, string>)[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
const onOff = (on: boolean) => ({ label: on ? S.on : S.off, tone: on ? 'good' : 'quiet' });
const withProblem = (section: GuideSection, problem: AccountGuideInput['problem']): GuideSection => (problem?.section === section.id ? { ...section, note: problem.text } : section);

function profileSection({ user }: AccountGuideInput): GuideSection {
  const name = user.name?.trim();
  return {
    id: 'profile', heading: S.profile_heading,
    rows: [
      { id: 'name', title: W.account_name, detail: name || W.account_name_unset, actions: [{ label: W.account_change, tone: 'quiet', href: '/sign-in/your-name' }] },
      { id: 'email', title: W.account_email, detail: user.email, ...(typeof user.emailVerified === 'boolean' ? { status: user.emailVerified ? { label: S.verified, tone: 'good' } : { label: S.not_verified, tone: 'attention' } } : {}), actions: [{ label: W.account_change, tone: 'quiet', href: '/sign-in/change-email' }] },
    ],
  };
}

function waysSection({ user, accounts }: AccountGuideInput): GuideSection {
  const hasPassword = accounts.some(account => account.providerId === 'credential');
  const others = accounts.filter(account => account.providerId !== 'credential');
  const otherRows: GuideRow[] = others.length
    ? others.map(account => ({ id: `account:${account.providerId}`, title: providerName(account.providerId), status: { label: S.connected, tone: 'good' } }))
    : [{ id: 'accounts', title: W.account_other, detail: W.account_other_none }];
  return {
    id: 'ways', heading: S.ways_heading, body: S.ways_body,
    rows: [
      { id: 'email-code', title: S.email_code, detail: S.email_code_detail, status: onOff(true) },
      { id: 'password', title: W.account_password, detail: hasPassword ? W.account_password_set : W.account_password_unset, status: onOff(hasPassword) },
      { id: 'authenticator', title: W.account_authenticator, status: onOff(user.twoFactorEnabled === true) },
      ...otherRows,
    ],
  };
}

function passkeysSection({ passkeys }: AccountGuideInput): GuideSection {
  return {
    id: 'passkeys', heading: W.account_passkeys, body: S.passkeys_body,
    ...(passkeys.length
      ? { rows: passkeys.map(passkey => ({ id: `passkey:${passkey.id}`, title: passkey.name || W.account_passkey_unnamed, detail: fill(S.passkey_detail, { when: when(passkey.createdAt) }),
        actions: [{ label: W.account_passkey_remove, tone: 'plain-danger', send: { path: ACCOUNT_ACTIONS.removePasskey, body: { id: passkey.id }, confirm: `${W.account_passkey_remove}?` } }] })) }
      : { empty: { icon: 'KeyRound', title: W.account_passkeys_none } }),
    actions: [{ label: W.account_add_passkey, tone: passkeys.length ? 'quiet' : 'primary', href: '/sign-in/add-passkey' }],
  };
}

function sessionsSection({ sessions, currentToken, here }: AccountGuideInput): GuideSection {
  const base = { id: 'sessions', heading: S.sessions_heading, body: S.sessions_body };
  if (sessions === 'not-fresh') {
    return { ...base, rows: [{ id: 'sessions-fresh', title: W.account_sessions_confirm, actions: [{ label: W.account_sessions_confirm_action, tone: 'quiet', href: `/sign-in?${new URLSearchParams({ next: here })}` }] }] };
  }
  if (sessions === 'failed') return { ...base, note: S.failed };
  // This device first, then the others by when they were last used.
  const ordered = [...sessions].sort((a, b) => Number(b.token === currentToken) - Number(a.token === currentToken) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const others = ordered.filter(session => session.token !== currentToken);
  return {
    ...base,
    rows: ordered.map((session, index) => {
      const mine = session.token === currentToken;
      return {
        id: `session:${index}`, title: deviceName(session.userAgent), detail: fill(S.session_detail, { when: when(session.updatedAt ?? session.createdAt) }),
        ...(mine ? { status: { label: S.this_device, tone: 'good' }, actions: [{ label: S.sign_out_here, tone: 'quiet', href: '/sign-out' }] }
          : { actions: [{ label: W.account_session_end, tone: 'quiet', send: { path: ACCOUNT_ACTIONS.endSession, body: { token: session.token } } }] }),
      };
    }),
    ...(others.length > 1 ? { actions: [{ label: S.sign_out_others, tone: 'quiet', send: { path: ACCOUNT_ACTIONS.endOtherSessions, confirm: S.sign_out_others_confirm } }] } : {}),
  };
}

function deleteSection({ accounts }: AccountGuideInput): GuideSection {
  const hasPassword = accounts.some(account => account.providerId === 'credential');
  const action = { label: W.account_delete, tone: 'danger', send: { path: ACCOUNT_ACTIONS.deleteAccount, confirm: S.delete_confirm, ...(hasPassword ? { with_fields: true } : {}) } };
  return {
    id: 'delete', heading: S.delete_heading, body: S.delete_body,
    ...(hasPassword
      ? { rows: [{ id: 'delete', title: W.account_delete_title, detail: W.account_password_needed, starts_open: true, fields: [{ name: 'password', label: W.account_password, secret: true }], actions: [action] }] }
      : { actions: [action] }),
  };
}

/** The account screen's description: profile, sign-in ways, passkeys, sessions and delete. */
export function accountGuide(input: AccountGuideInput): GuideDescription {
  return {
    title: S.title, lead: S.lead,
    sections: [profileSection(input), waysSection(input), passkeysSection(input), sessionsSection(input), deleteSection(input)].map(section => withProblem(section, input.problem)),
  };
}

export { signInWords, screenWords };
