// packages/service-connections/show/__tests__/ConnectedAccountsSection.test.tsx
//
// The dynamic connected-accounts list (the regression the owner reported: the
// add-account modal stopped showing which accounts are already connected).
// Contract under test:
//   1. Only REAL instances render (empty list -> the section renders NOTHING).
//   2. Each row shows the account identity + connect date.
//   3. Manage discloses rename (writes via onRename), reveal (masked by
//      default; plaintext only after the explicit per-field Show click), and
//      per-instance disconnect (onDisconnect with THAT id only).
//   4. Reveal is lazy — onReveal is NOT called until the explicit click.
// Offline, real component, jsdom.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedAccountsSection } from '@/packages/service-connections/show/ConnectedAccountsSection';
import type { RevealedServiceCredentialField } from '@/packages/service-connections/do-work/reveal-service-connection-credential';

afterEach(cleanup);

const TWO_ACCOUNTS = [
  {
    id: 'service_connection:gmail',
    accountLabel: 'work@example.com',
    connectedAt: '2026-07-01T10:00:00.000Z',
    status: 'connected',
  },
  {
    id: 'service_connection:gmail:2',
    accountLabel: 'personal@example.com',
    connectedAt: '2026-07-10T10:00:00.000Z',
    status: 'connected',
  },
];

function mount(overrides: {
  accounts?: typeof TWO_ACCOUNTS;
  onRename?: (id: string, label: string) => Promise<void>;
  onDisconnect?: (id: string) => Promise<void>;
  onReveal?: (id: string) => Promise<RevealedServiceCredentialField[]>;
} = {}) {
  const onRename = overrides.onRename ?? vi.fn(async () => {});
  const onDisconnect = overrides.onDisconnect ?? vi.fn(async () => {});
  const onReveal = overrides.onReveal ?? vi.fn(async () => []);
  const utils = render(
    <ConnectedAccountsSection
      accounts={overrides.accounts ?? TWO_ACCOUNTS}
      onRename={onRename}
      onDisconnect={onDisconnect}
      onReveal={onReveal}
    />,
  );
  return { ...utils, onRename, onDisconnect, onReveal };
}

function buttonNamed(pattern: RegExp): HTMLButtonElement {
  return screen
    .getAllByRole('button')
    .find((b) => pattern.test(b.textContent ?? '')) as HTMLButtonElement;
}

describe('ConnectedAccountsSection', () => {
  it('renders NOTHING when there are no real instances (L117)', () => {
    const { container } = mount({ accounts: [] });
    expect(container.textContent).toBe('');
  });

  it('renders one row per REAL instance with account identity and count header', () => {
    mount();
    expect(screen.getByText('Connected accounts (2)')).toBeTruthy();
    expect(screen.getByText('work@example.com')).toBeTruthy();
    expect(screen.getByText('personal@example.com')).toBeTruthy();
  });

  it('an unnamed instance renders an honest fallback, never a fake identity', () => {
    mount({
      accounts: [{ id: 'service_connection:x', accountLabel: '', connectedAt: null, status: 'connected' }],
    });
    expect(screen.getByText('Unnamed account')).toBeTruthy();
  });

  it('rename saves through onRename with THIS instance id and the new label', async () => {
    const onRename = vi.fn(async () => {});
    mount({ onRename });

    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    // Reveal keeps closed rows mounted (hidden), so BOTH rows' inputs exist in
    // the DOM — take the first (the row whose Manage we just opened).
    const input = screen.getAllByLabelText('Account label')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Work Gmail' } });
    await act(async () => {
      fireEvent.click(buttonNamed(/^Save$/));
    });

    expect(onRename).toHaveBeenCalledWith('service_connection:gmail', 'Work Gmail');
  });

  it('disconnect fires for THIS instance only', async () => {
    const onDisconnect = vi.fn(async () => {});
    mount({ onDisconnect });

    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    await act(async () => {
      fireEvent.click(buttonNamed(/Disconnect this account/));
    });

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('service_connection:gmail');
  });

  it('reveal is LAZY, arrives MASKED, and unmasks only on the explicit per-field click', async () => {
    const fields: RevealedServiceCredentialField[] = [
      { secretName: 'sc-abc-field-6170695f6b6579', fieldId: 'api_key', label: 'Api Key', value: 'sk-SECRET-123' },
    ];
    const onReveal = vi.fn(async () => fields);
    mount({ onReveal });

    // Not called before the explicit click.
    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    expect(onReveal).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(buttonNamed(/Show stored credential/));
    });
    expect(onReveal).toHaveBeenCalledWith('service_connection:gmail');

    // Masked by default: label visible, plaintext NOT in the document.
    expect(screen.getByText('Api Key')).toBeTruthy();
    expect(screen.queryByText('sk-SECRET-123')).toBeNull();

    // Explicit unmask reveals; Hide re-masks.
    await act(async () => {
      fireEvent.click(buttonNamed(/^Show$/));
    });
    expect(screen.getByText('sk-SECRET-123')).toBeTruthy();
    await act(async () => {
      fireEvent.click(buttonNamed(/^Hide$/));
    });
    expect(screen.queryByText('sk-SECRET-123')).toBeNull();
  });

  it('closing Manage DROPS revealed plaintext (the reveal session ends with the disclosure)', async () => {
    const fields: RevealedServiceCredentialField[] = [
      { secretName: 'sc-abc-field-6170695f6b6579', fieldId: 'api_key', label: 'Api Key', value: 'sk-SECRET-123' },
    ];
    mount({ onReveal: vi.fn(async () => fields) });

    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    await act(async () => {
      fireEvent.click(buttonNamed(/Show stored credential/));
    });
    await act(async () => {
      fireEvent.click(buttonNamed(/^Show$/));
    });
    expect(screen.getByText('sk-SECRET-123')).toBeTruthy();

    // Close the disclosure — the plaintext must not survive it.
    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    expect(screen.queryByText('sk-SECRET-123')).toBeNull();
    // Re-opening starts a FRESH session: back to the lazy reveal affordance.
    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    expect(screen.queryByText('sk-SECRET-123')).toBeNull();
    expect(buttonNamed(/Show stored credential/)).toBeTruthy();
  });

  it('a credential-less account reports honestly instead of inventing rows', async () => {
    mount({ onReveal: vi.fn(async () => []) });

    await act(async () => {
      fireEvent.click(buttonNamed(/Manage/));
    });
    await act(async () => {
      fireEvent.click(buttonNamed(/Show stored credential/));
    });
    expect(screen.getByText(/No stored credential/)).toBeTruthy();
  });
});
