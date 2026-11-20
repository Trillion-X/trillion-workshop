import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { sessionAuthorityState } from '../read-data/session-authority-state.ts';

const session = (state: string) => ({
  accountIdHash: 'acct-hash',
  authority: { actor_ref: 'acct-hash', session_ref: 'sess-1', session_revision: 2, expires_at_milliseconds: 4102444800000, state },
});

describe('a browser session reads its own state', () => {
  it('an active session is active for its account', () => {
    expect(sessionAuthorityState(session('active'))).toEqual({ active: true, subject: 'acct-hash' });
  });

  it('a revoked session is not active', () => {
    expect(sessionAuthorityState(session('revoked'))).toEqual({ active: false, subject: 'acct-hash' });
  });

  it('refuses an unknown state and an authority that names another actor', () => {
    expect(() => sessionAuthorityState(session('pending'))).toThrow('Session authority is invalid.');
    expect(() => sessionAuthorityState({ accountIdHash: 'acct-hash', authority: { ...session('active').authority, actor_ref: 'other' } }))
      .toThrow('Session authority is invalid.');
  });
});
