// Offline mount proof for the headless Supabase completion companion (Task #17 U1).
// On a magic-link return (?supabase_sign_in=complete + token_hash + type + descriptor) it must
// exchange the token via completeSupabaseSignIn, strip the one-time params, and RELOAD (so the
// shell observes the new server-side session). Every other case is an honest no-op. Headless.
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTargetMock = vi.fn();
const useBitfieldDataMock = vi.fn();
const completeMock = vi.fn(async () => ({ accountId: 'acct_1', email: 'person@example.com', ok: true }));
const descriptorMock = vi.fn();
vi.mock('@bitfield/runtime-kit', () => ({ sendRequestToBitfieldTarget: (...a: unknown[]) => sendTargetMock(...a) }));
vi.mock('@bitfield/runtime-kit/react', () => ({ useBitfieldData: (...a: unknown[]) => useBitfieldDataMock(...a) }));
vi.mock('@/packages/ui', () => ({ mountReactSurface: () => () => {} }));
vi.mock('@/packages/supabase-sign-in/do-work/complete-supabase-sign-in', () => ({
  completeSupabaseSignIn: (...a: unknown[]) => completeMock(...a),
}));
vi.mock('@/packages/supabase-sign-in/read-data/read-supabase-sign-in-records', () => ({
  readSupabaseSignInDescriptor: (...a: unknown[]) => descriptorMock(...a),
}));
vi.mock('@/packages/account-session/do-work/browser-session-browser-id', () => ({
  currentLogBrowserSessionBrowserId: () => 'browser_test_1',
}));

import { SupabaseSignInCompletionCompanion } from './mount-supabase-sign-in-completion';

const DESCRIPTOR = { id: 'supabase-sign-in:primary', kind: 'supabase-sign-in-descriptor' };
const assignMock = vi.fn();

function setUrl(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: '/app', search, hash: '', href: `http://localhost/app${search}`, assign: assignMock },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sendTargetMock.mockReset();
  useBitfieldDataMock.mockReset();
  completeMock.mockClear();
  descriptorMock.mockReset();
  assignMock.mockClear();
  descriptorMock.mockReturnValue(DESCRIPTOR);
  useBitfieldDataMock.mockReturnValue([DESCRIPTOR]);
});
afterEach(cleanup);

describe('SupabaseSignInCompletionCompanion — full magic-link completion lifecycle (Option B)', () => {
  it('COMPLETES + RELOADS: valid return -> completeSupabaseSignIn(token) -> strip params -> location.assign', async () => {
    setUrl('?supabase_sign_in=complete&token_hash=th_abc&type=magiclink');
    const { container } = render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const arg = completeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.token_hash).toBe('th_abc');
    expect(arg.type).toBe('magiclink');
    expect(arg.provider).toBe(DESCRIPTOR);
    expect(arg.provider_id).toBe('supabase-sign-in:primary');
    expect(arg.browser_id).toBe('browser_test_1');
    // reloaded to the cleaned URL (one-time params stripped), shell will observe the new session
    expect(assignMock).toHaveBeenCalledTimes(1);
    const cleaned = assignMock.mock.calls[0][0] as string;
    expect(cleaned).not.toMatch(/supabase_sign_in|token_hash|type=/);
    expect(cleaned).toBe('/app');
    expect(container.firstChild).toBeNull(); // headless
  });

  it('NO-OP: ordinary visit (no supabase_sign_in param) -> no completion, no reload', async () => {
    setUrl('?utm_source=google');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    expect(completeMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('NO-OP: completion flag but missing token_hash/type -> honest no-op (cannot complete)', async () => {
    setUrl('?supabase_sign_in=complete');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    expect(completeMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('NO-OP: no provider descriptor available -> cannot complete, no reload', async () => {
    descriptorMock.mockReturnValue(null);
    setUrl('?supabase_sign_in=complete&token_hash=th&type=magiclink');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    expect(completeMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: completeSupabaseSignIn throws -> no reload (visitor stays anon, can retry)', async () => {
    completeMock.mockRejectedValueOnce(new Error('verify failed'));
    setUrl('?supabase_sign_in=complete&token_hash=th&type=magiclink');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('DATA-DRIVEN descriptor: reads the injected provider-records input when no prop given', async () => {
    setUrl('?supabase_sign_in=complete&token_hash=th&type=magiclink');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();
    // the descriptor reader was fed the injected input (useBitfieldData('supabase-provider-records'))
    expect(useBitfieldDataMock).toHaveBeenCalledWith('supabase-provider-records');
    expect(descriptorMock).toHaveBeenCalledWith([DESCRIPTOR]);
  });

  it('AUTO-JOINS descriptor-authored free subjects before reload', async () => {
    descriptorMock.mockReturnValue({
      ...DESCRIPTOR,
      auto_join_subjects: ['community:trillion-community'],
    });
    sendTargetMock.mockResolvedValue({
      status: 'accepted',
      revision: 1,
      row: { participation_ref: 'participant:acct_1', removed: false },
    });
    setUrl('?supabase_sign_in=complete&token_hash=th&type=magiclink');
    render(React.createElement(SupabaseSignInCompletionCompanion));
    await flush();

    expect(sendTargetMock).toHaveBeenCalledTimes(1);
    expect(sendTargetMock).toHaveBeenCalledWith({
      target: 'subject-participant.join-subject',
      payload: expect.objectContaining({
        subject_ref: 'community:trillion-community',
        expected_revision: 0,
      }),
    });
    expect(assignMock).toHaveBeenCalledTimes(1);
  });
});
