// @vitest-environment jsdom
// Proof: when the curation SUBMIT dispatch fails (e.g. the `slot::workflow` target is
// not served on this carrier — the exact live store behavior), the AI-curation panel
// surfaces a real error state instead of hanging forever on "Curating...".
// Guards the unhandled-promise-rejection bug: on the live store the poll read succeeds
// but returns found:false (stays "loading") while the submit to slot::workflow throws
// unhandled -> endless spinner. The submit-side try/catch converts that to an error state.
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: sendMock,
}));
vi.mock('@bitfield/runtime-kit/protocol', () => ({
  // The poll read: build an opaque request and always decode to "not found"
  // so the poll stays in the loading state (mirrors the live store, where the
  // result was never produced because the submit failed).
  buildEngineReadCurrentRequestFromLabels: () => ({ __poll_read: true }),
  decodeEngineReadCurrentReply: () => ({ found: false, payload: null }),
}));

import { AICurationPanelComponent } from './AICurationPanelComponent';

afterEach(() => {
  cleanup();
  sendMock.mockReset();
});

describe('AICurationPanelComponent — submit dispatch failure', () => {
  it('shows an error (not an endless spinner) when the submit target is unserved', async () => {
    sendMock.mockImplementation(async (req: unknown) => {
      // The submit dispatch targets slot::workflow -> simulate "unknown target".
      if (req && typeof req === 'object' && (req as { target?: string }).target === 'slot::workflow') {
        throw new Error('unknown target: slot::workflow');
      }
      // The poll read -> return bytes; decode mock reports not-found (stays loading).
      return new Uint8Array([1]);
    });

    render(<AICurationPanelComponent curatingQuery="checkout flow" onBack={vi.fn()} />);

    await waitFor(() => {
      // Shows plain domain language, NEVER the raw internal error
      // ("unknown target: slot::workflow") — L114.
      expect(screen.getByText("AI curation isn't available right now.")).toBeTruthy();
    });
    expect(screen.queryByText(/unknown target|slot::workflow/)).toBeNull();
    // And it must NOT be stuck showing the loading text.
    expect(screen.queryByText('Curating...')).toBeNull();
  });

  it('falls back to a friendly message when the failure has no message', async () => {
    sendMock.mockImplementation(async (req: unknown) => {
      if (req && typeof req === 'object' && (req as { target?: string }).target === 'slot::workflow') {
        throw 'boom';
      }
      return new Uint8Array([1]);
    });

    render(<AICurationPanelComponent curatingQuery="dark mode" onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("AI curation isn't available right now.")).toBeTruthy();
    });
  });
});
