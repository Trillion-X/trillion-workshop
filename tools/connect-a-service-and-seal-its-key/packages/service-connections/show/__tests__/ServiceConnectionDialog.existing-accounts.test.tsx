// packages/service-connections/show/__tests__/ServiceConnectionDialog.existing-accounts.test.tsx
//
// Regression for the reported bug: "when I click 'Add account' it showed a
// modal with a DYNAMIC DATA LIST of the accounts I have connected. That list
// stopped showing." The dialog previously rendered ONLY the connect form —
// existing instances were invisible, so the owner couldn't tell which email
// account was already connected. Contract under test:
//   1. With existingAccounts + management callbacks wired, the dialog shows
//      the connected-accounts list ABOVE the connect form.
//   2. With NO existing accounts, the dialog renders exactly as before (the
//      list contributes nothing — no header, no placeholder rows).
//   3. Without the management callbacks (older callers), the dialog renders
//      exactly as before — the section is opt-in and non-breaking.
// Offline, real components, jsdom.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceConnectionDialog } from '@/packages/service-connections/show/ServiceConnectionDialog';
import type { ServiceAuthConfig } from '@/packages/service-connections/read-data/read-service-connection-options';
import { LAYER_ORDER } from '@/packages/ui';

afterEach(cleanup);

const PASTE_CONFIG = {
  vendor: 'gmail',
  name: 'Gmail',
  credentialFields: [
    { id: 'app_password', label: 'App password', required: true, secret: true, guideSteps: [] },
  ],
  helperLinks: [],
} as unknown as ServiceAuthConfig;

const ACCOUNTS = [
  {
    id: 'service_connection:gmail',
    accountLabel: 'work@example.com',
    connectedAt: '2026-07-01T10:00:00.000Z',
    status: 'connected',
  },
];

const managementCallbacks = () => ({
  onRenameAccount: vi.fn(async () => {}),
  onDisconnectAccount: vi.fn(async () => {}),
  onRevealAccountCredentials: vi.fn(async () => []),
});

describe('ServiceConnectionDialog existing-accounts list', () => {
  it('paints above the guided walkthrough that can open it', () => {
    render(
      <ServiceConnectionDialog
        open
        serviceName="Gmail"
        authConfig={PASTE_CONFIG}
        onClose={() => {}}
        onAuthenticate={async () => {}}
      />,
    );

    const overlay = screen.getByRole('dialog');
    expect((overlay.closest('[data-arrangement-pip-plane]') as HTMLElement).style.zIndex).toBe(String(LAYER_ORDER.walkthrough + 1));
    expect(overlay.className).toContain('coss-floating-panel');
    expect(overlay.getAttribute('aria-modal')).toBeNull();
  });

  it('shows the dynamic connected-accounts list above the connect form', () => {
    render(
      <ServiceConnectionDialog
        open
        serviceName="Gmail"
        authConfig={PASTE_CONFIG}
        onClose={() => {}}
        onAuthenticate={async () => {}}
        existingAccounts={ACCOUNTS}
        {...managementCallbacks()}
      />,
    );

    // The list: header + the real account identity.
    expect(screen.getByText('Connected accounts (1)')).toBeTruthy();
    expect(screen.getByText('work@example.com')).toBeTruthy();
    // The connect form still renders below — adding another account stays possible.
    expect(screen.getByLabelText('App password')).toBeTruthy();
  });

  it('renders NO list artifacts when there are no existing accounts (L117)', () => {
    render(
      <ServiceConnectionDialog
        open
        serviceName="Gmail"
        authConfig={PASTE_CONFIG}
        onClose={() => {}}
        onAuthenticate={async () => {}}
        existingAccounts={[]}
        {...managementCallbacks()}
      />,
    );

    expect(screen.queryByText(/Connected accounts/)).toBeNull();
    expect(screen.getByLabelText('App password')).toBeTruthy();
  });

  it('renders exactly as before when management callbacks are not wired (opt-in, non-breaking)', () => {
    render(
      <ServiceConnectionDialog
        open
        serviceName="Gmail"
        authConfig={PASTE_CONFIG}
        onClose={() => {}}
        onAuthenticate={async () => {}}
        existingAccounts={ACCOUNTS}
      />,
    );

    expect(screen.queryByText(/Connected accounts/)).toBeNull();
    expect(screen.getByLabelText('App password')).toBeTruthy();
  });
});
