// packages/service-connections/show/__tests__/ServiceConnectionDialog.acquire-close.test.tsx
//
// Regression for the "modal vanished in an instant" bug. When the user taps the
// acquire button, `onAcquire` LAUNCHES the connect flow and resolves with an
// outcome that describes WHAT happened next:
//   - {}                      -> a live session is now running; its pairing code
//                                will stream in as `liveChallenge`. The dialog
//                                MUST stay open (previously it closed instantly,
//                                so WhatsApp Baileys pairing never completed).
//   - { accountLabel }        -> a self-completing acquire already connected;
//                                the dialog closes.
//   - { device }              -> a browserless device code to present; stays open.
// Offline, real component, jsdom.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ServiceConnectionDialog,
} from '@/packages/service-connections/show/ServiceConnectionDialog';
import type {
  ServiceAuthConfig,
} from '@/packages/service-connections/read-data/read-service-connection-options';
import type { ServiceAcquireOutcome } from '@/packages/service-connections/show/ServiceConnectionDialog';

afterEach(cleanup);

const ACQUIRE_CONFIG = {
  vendor: 'whatsapp',
  credentialFields: [],
  helperLinks: [],
  acquire: { flow: 'session_challenge', process: { argv: ['node', 'x'] } },
} as unknown as ServiceAuthConfig;

function mount(
  onAcquire: (fields: Record<string, string>) => Promise<ServiceAcquireOutcome>,
  onClose: () => void,
) {
  return render(
    <ServiceConnectionDialog
      open
      serviceName="WhatsApp"
      authConfig={ACQUIRE_CONFIG}
      onClose={onClose}
      onAuthenticate={async () => {}}
      onAcquire={onAcquire}
      liveChallenge={null}
    />,
  );
}

function acquireButton(): HTMLButtonElement {
  return screen
    .getAllByRole('button')
    .find((b) => /Continue with/.test(b.textContent ?? '')) as HTMLButtonElement;
}

describe('ServiceConnectionDialog acquire close behavior', () => {
  it('session-backed launch (empty outcome) KEEPS the dialog open and shows a waiting state', async () => {
    const onClose = vi.fn();
    const onAcquire = vi.fn(async () => ({}) as ServiceAcquireOutcome);
    mount(onAcquire, onClose);

    await act(async () => {
      fireEvent.click(acquireButton());
    });

    expect(onAcquire).toHaveBeenCalledTimes(1);
    // THE BUG: onClose must NOT fire — the pairing code has not streamed in yet.
    expect(onClose).not.toHaveBeenCalled();
    // A calm waiting state holds the dialog open until `liveChallenge` arrives.
    await waitFor(() => expect(screen.getByText(/Starting the connection/)).toBeTruthy());
    // And the primary action is disabled so a second tap cannot spawn a
    // duplicate connect session while we wait.
    expect(acquireButton().disabled).toBe(true);
  });

  it('self-completing acquire (accountLabel) CLOSES the dialog', async () => {
    const onClose = vi.fn();
    const onAcquire = vi.fn(async () => ({ accountLabel: 'WhatsApp — +1 205…' }) as ServiceAcquireOutcome);
    mount(onAcquire, onClose);

    await act(async () => {
      fireEvent.click(acquireButton());
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('device-code acquire presents the code and STAYS open (no close)', async () => {
    const onClose = vi.fn();
    const onAcquire = vi.fn(async () =>
      ({ device: { userCode: 'WXYZ-9876', verificationUri: 'https://example.com/activate' } }) as ServiceAcquireOutcome,
    );
    mount(onAcquire, onClose);

    await act(async () => {
      fireEvent.click(acquireButton());
    });

    await waitFor(() => expect(screen.getByText('WXYZ-9876')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
