// packages/notifications/show/__tests__/notification-setting-screen.test.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The L116 integration proof for the React/web envelope: not "the pieces exist"
// but "a real user can complete the real job." It mounts the actual envelope
// (NotificationSettingScreen) over the package's REAL published records
// (things-to-store-and-run.json) and drives the full interaction the way a human
// does — read the current choice, pick a different one, save, see it confirmed —
// asserting that the save fires the CANONICAL action route envelope the policy
// reader resolves (SSOT: one route, one reader, consumed by the write authority).
//
// The chain under test is the live one, end to end:
//   things-to-store-and-run.json  (real contract)
//     → readSurfaceInput / readNotificationsPolicy   (resolve descriptor + route)
//     → projectSettingView                           (blind HumanSettingView)
//     → BlindSettingRenderer (option cards + save bar)
//     → saveSetting(policy.actionRoute)              (assemble + send envelope)
//
// Mocks are limited to the two real I/O seams: the live-value data hook
// (useBitfieldData) and the runtime-kit sender (sendRequestToBitfieldTarget).
// Everything between them is the production code path.
//
// Domain literals (mode keys, target, action id) appear here ON PURPOSE — this
// is a wire-shape proof. The banned-literal rule governs the blind show/ and
// do-work/ SOURCE, never the tests that pin their output.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';

import boundary from '../../things-to-store-and-run.json';
import { NotificationSettingScreen } from '../notification-setting-screen';

// The runtime-kit sender is the one real side effect the save performs — replace
// just the routed call so the test asserts the wire shape without I/O.
const sendMock = vi.fn(async (_invocation: { target: string; payload: unknown }) => ({ ok: true }));
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: (invocation: { target: string; payload: unknown }) => sendMock(invocation),
}));

// The live-value data hook is the other I/O seam — mock it so the test controls
// what the engine reports as the saved value.
vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: vi.fn(),
}));

// The package hands the surface its own published records; the envelope finds the
// setting-control among them and resolves the action route from the graph record.
const surfaceProps = { records: boundary.things };

// The exact envelope the owner expects for a focus-mode set — generic invoke
// protocol keys, opaque mode id at the route's value path, response-control flags
// flowing as DATA from the route's payload_defaults.
const FOCUS_ENVELOPE = {
  operation: 'execute_definition',
  definition_id: 'action:update-workspace-notification-mode',
  include_steps: false,
  include_output: false,
  input: { mode_id: 'focus' },
};

function settingScreen(): HTMLElement {
  return document.querySelector('[data-setting-screen]') as HTMLElement;
}
function saveButton(): HTMLButtonElement {
  return document.querySelector('[data-setting-save]') as HTMLButtonElement;
}
function revertButton(): HTMLButtonElement {
  return document.querySelector('[data-setting-revert]') as HTMLButtonElement;
}

beforeEach(() => {
  sendMock.mockClear();
  // No live rows → the policy reader falls back to the descriptor default
  // ('normal' is the current/saved choice). This isolates the interaction from
  // any particular live value while exercising the live (useBitfieldData) path.
  vi.mocked(useBitfieldData).mockReturnValue([]);
});

afterEach(() => cleanup());

describe('notification setting screen — web envelope integration', () => {
  it('renders the described options with the saved choice marked current and Save disabled', () => {
    render(<NotificationSettingScreen props={surfaceProps} />);

    // Reference anatomy: one card per described option, the saved one badged.
    const options = document.querySelectorAll('[data-setting-option]');
    expect(options).toHaveLength(4);
    expect(screen.getByRole('radio', { name: /Normal/i }).getAttribute('data-current')).toBe('true');
    // Nothing changed yet → clean 'ready' state, Save not actionable.
    expect(settingScreen().getAttribute('data-status')).toBe('ready');
    expect(saveButton().disabled).toBe(true);
  });

  it('completes the select → dirty → save → saved round-trip and fires the canonical route', async () => {
    render(<NotificationSettingScreen props={surfaceProps} />);

    // 1. Pick a different described option.
    fireEvent.click(screen.getByRole('radio', { name: /Focus/i }));
    expect(settingScreen().getAttribute('data-status')).toBe('dirty');
    expect(screen.getByRole('radio', { name: /Focus/i }).getAttribute('data-selected')).toBe('true');
    expect(saveButton().disabled).toBe(false);

    // 2. Save → the write authority routes through policy.actionRoute, sending the
    //    owner's exact execute envelope to the named target. One call, one shape.
    fireEvent.click(saveButton());
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith({ target: 'slot::workflow', payload: FOCUS_ENVELOPE });

    // 3. The engine is authority: the pending choice clears and a transient
    //    confirmation surfaces.
    await waitFor(() => expect(settingScreen().getAttribute('data-status')).toBe('saved'));
  });

  it('reverts a pending choice back to the clean state without sending anything', () => {
    render(<NotificationSettingScreen props={surfaceProps} />);

    fireEvent.click(screen.getByRole('radio', { name: /Do Not Disturb/i }));
    expect(settingScreen().getAttribute('data-status')).toBe('dirty');

    fireEvent.click(revertButton());
    expect(settingScreen().getAttribute('data-status')).toBe('ready');
    expect(saveButton().disabled).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('blocks the save and sends nothing while offline, even after a pending pick', () => {
    // navigator.onLine is a prototype getter (no own descriptor); shadow it with
    // an own `false` property, then DELETE the shadow on cleanup so the prototype
    // `true` is restored and the offline state cannot leak into later tests.
    const original = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    try {
      render(<NotificationSettingScreen props={surfaceProps} />);
      expect(settingScreen().getAttribute('data-status')).toBe('offline');

      // A pick while offline does not unlock the save — offline wins.
      fireEvent.click(screen.getByRole('radio', { name: /Scheduled/i }));
      expect(settingScreen().getAttribute('data-status')).toBe('offline');
      expect(saveButton().disabled).toBe(true);

      fireEvent.click(saveButton());
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(window.navigator, 'onLine', original);
      else delete (window.navigator as { onLine?: boolean }).onLine;
    }
  });

  it('shows no backend vocabulary anywhere in the rendered surface (translation boundary)', () => {
    render(<NotificationSettingScreen props={surfaceProps} />);
    const visible = (settingScreen().textContent ?? '').toLowerCase();
    for (const banned of [
      'mode_id',
      'modeid',
      'prop:settings:notification_mode',
      'prop:notification-mode',
      'slot::workflow',
      'execute_definition',
      'action:update-workspace-notification-mode',
      'descriptor',
      'payload',
      'envelope',
      'fact',
      'package::',
    ]) {
      expect(visible.includes(banned)).toBe(false);
    }
  });

  it('keeps the option group itself free of any current-value backend key', () => {
    render(<NotificationSettingScreen props={surfaceProps} />);
    const group = document.querySelector('[data-setting-options]') as HTMLElement;
    // Every option card reads a human label + description; the opaque mode id is
    // carried as a data hook for selection, never shown as visible text.
    expect(within(group).getByText('Normal')).toBeTruthy();
    expect(within(group).getByText('Focus')).toBeTruthy();
    expect(within(group).getByText('Do Not Disturb')).toBeTruthy();
    expect(within(group).getByText('Scheduled')).toBeTruthy();
  });
});
