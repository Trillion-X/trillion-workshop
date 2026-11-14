// packages/service-connections/show/__tests__/ServiceConnectionDialog.live-challenge.test.tsx
//
// Proves the dialog's LIVE mid-process challenge render (W3c unit 2b): a
// session-backed acquire (WhatsApp Baileys pairing, QR, device code) emits its
// challenge WHILE the process blocks — the surface feeds it in reactively as
// `liveChallenge` and the dialog must (1) render the code + self-described
// instructions BLINDLY (no vendor/kind branching — L090), (2) prefer it over
// the resolve-then-show `device` outcome (which structurally cannot carry a
// mid-run code), (3) disable the re-acquire button while a challenge is live,
// and (4) fall back to the one-tap copy when no challenge exists. Offline,
// real component, jsdom.
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ServiceConnectionDialog,
} from '@/packages/service-connections/show/ServiceConnectionDialog';
import type {
  ServiceAuthConfig,
} from '@/packages/service-connections/read-data/read-service-connection-options';

afterEach(cleanup);

const ACQUIRE_CONFIG = {
  vendor: 'whatsapp',
  credentialFields: [],
  helperLinks: [],
  // presence of `acquire` selects the one-click render shape (data-described)
  acquire: { flow: 'session_challenge', process: { argv: ['node', 'x'] } },
} as unknown as ServiceAuthConfig;

function mountDialog(liveChallenge: { type: string; fields: Record<string, unknown> } | null) {
  return render(
    <ServiceConnectionDialog
      open
      serviceName="WhatsApp"
      authConfig={ACQUIRE_CONFIG}
      onClose={() => {}}
      onAuthenticate={async () => {}}
      onAcquire={async () => ({})}
      liveChallenge={liveChallenge}
    />,
  );
}

describe('ServiceConnectionDialog live challenge (session-backed acquire)', () => {
  it('renders a pairing code with its self-described instructions', () => {
    mountDialog({
      type: 'pairing_code',
      fields: {
        code: 'ABCD1234',
        instructions: 'In WhatsApp go to Settings → Linked Devices → Link with phone number, then enter this code.',
      },
    });
    expect(screen.getByText('ABCD1234')).toBeTruthy();
    expect(screen.getByText(/Linked Devices/)).toBeTruthy();
    // stays-open guidance present
    expect(screen.getByText(/connects automatically/)).toBeTruthy();
  });

  it('renders a device-code-style challenge via verification_uri + user_code (no kind branching)', () => {
    mountDialog({
      type: 'device_code',
      fields: { user_code: 'WXYZ-9876', verification_uri: 'https://example.com/activate' },
    });
    expect(screen.getByText('WXYZ-9876')).toBeTruthy();
    expect(screen.getByText(/example\.com\/activate/)).toBeTruthy();
  });

  it('an UNKNOWN future challenge kind still renders its code + hint (L090, no enum)', () => {
    mountDialog({
      type: 'webauthn_tap',
      fields: { code: 'TAP-NOW', hint: 'Touch your security key.' },
    });
    expect(screen.getByText('TAP-NOW')).toBeTruthy();
    expect(screen.getByText('Touch your security key.')).toBeTruthy();
  });

  it('disables the acquire button while a challenge is live (no double-launch)', () => {
    mountDialog({ type: 'pairing_code', fields: { code: 'ABCD1234' } });
    const connect = screen.getAllByRole('button').find((b) => (b as HTMLButtonElement).disabled);
    expect(connect).toBeTruthy();
  });

  it('no challenge -> the one-tap acquire copy renders (fallback intact)', () => {
    mountDialog(null);
    expect(screen.getByText(/Nothing to copy or paste/)).toBeTruthy();
    expect(screen.queryByText(/connects automatically/)).toBeNull();
  });
});
