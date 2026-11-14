// The account a person signed in to, carried in every pass this tool signs. settings.account_claim names the user field
// that holds it (`field`, a user additional field the person cannot set: input false) and the claim it goes out as
// (`claim`). The session JWT keeps its default payload (the user) and adds the claim; an MCP access token gets it through
// the OAuth provider's customAccessTokenClaims. No account_claim in the settings, or a user with no account: no claim.
// A new person's account is made at the computer beside this tool when account_claim names `create` (accountCreate).

import { APIError } from 'better-auth/api';

const of = settings => settings.account_claim ?? null;
const claimFor = (named, user) => (named && user?.[named.field] ? { [named.claim]: user[named.field] } : {});

/** The user additional fields the account needs (Better Auth `user.additionalFields`). */
export const accountFields = settings => {
  const named = of(settings);
  return named ? { [named.field]: { type: 'string', required: false, input: false } } : {};
};

/** The jwt plugin's definePayload: the default payload (the user) with the account claim. */
export const sessionPayload = settings => ({ user }) => ({ ...user, ...claimFor(of(settings), user) });

/** The OAuth provider's customAccessTokenClaims: the account claim of the user a token is for, and their email with whether
 * it is verified (OIDC's `email`, `email_verified`), so a door can tell a proven inbox from a typed one. */
export const accessTokenClaims = settings => ({ user }) => ({
  ...claimFor(of(settings), user),
  ...(user?.email ? { email: user.email, email_verified: user.emailVerified === true } : {}),
});

/** An API key's metadata entry for the account of the party creating it (empty when it has none). */
export const keyAccount = (settings, user) => claimFor(of(settings), user);

/** Better Auth `databaseHooks.user.create.before`: a new person's account is made at the computer this tool runs beside, and
 * its address goes in the account field before the user row is written. `account_claim.create` names that computer's
 * loopback operation (`url`, the engine's POST /accounts/create, body {}, answered {"address"}: trillion-rust
 * src/native_entry/computer/account_create.rs) and how long to wait (`timeout_ms`). No `create`: no account is made here.
 * A computer that refuses or does not answer refuses the sign-up, so no person is left without an account. */
export const accountCreate = (settings, fetchImpl = fetch) => async user => {
  const named = of(settings);
  if (!named?.create) return { data: user };
  const refused = why => new APIError('SERVICE_UNAVAILABLE', { message: `The account could not be made: ${why}.`, code: 'ACCOUNT_NOT_MADE' });
  const answer = await fetchImpl(named.create.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(named.create.timeout_ms),
  }).catch(() => { throw refused('the computer did not answer'); });
  const made = await answer.json().catch(() => null);
  if (!answer.ok || !/^[0-9a-f]{64}$/.test(made?.address ?? '')) throw refused(`the computer answered ${answer.status} ${made?.error ?? ''}`.trim());
  return { data: { ...user, [named.field]: made.address } };
};
