// tools/paid-access/read-data/session-authority-state.ts
//
// The one pure reading of a browser session's authority: whether the session is active and which account's access it reads.
// It reads no clock. A session's end is its pass's own expiry: the engine refuses an expired pass where the pass is verified
// (trillion-rust src/auth_pass.rs:248, `exp + skew < now` is Expired), and carries that `exp` as the session's
// `expires_at_ms` (src/account/signed_in.rs:478). A session the owner revokes is ended by its state here.

type Obj = Record<string, unknown>;

function record(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type SessionAuthorityState = { active: boolean; subject: string };

/** `session` is the owner's session record (`root.session`, not null). Throws when its authority is not a shape this reads. */
export function sessionAuthorityState(session: unknown): SessionAuthorityState {
  if (!record(session)) throw new Error('Session could not be read.');
  const authority = session.authority;
  const subject = session.accountIdHash ?? session.accountId;
  if (!record(authority) || typeof subject !== 'string' || !subject.trim()
    || authority.actor_ref !== subject || typeof authority.session_ref !== 'string' || !authority.session_ref.trim()
    || !Number.isSafeInteger(authority.session_revision) || Number(authority.session_revision) <= 0
    || !Number.isSafeInteger(authority.expires_at_milliseconds) || Number(authority.expires_at_milliseconds) < 0) {
    throw new Error('Session authority is invalid.');
  }
  if (authority.state === 'revoked') return { active: false, subject };
  if (authority.state !== 'active') throw new Error('Session authority is invalid.');
  return { active: true, subject };
}
