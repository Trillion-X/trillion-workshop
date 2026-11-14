// packages/notifications/do-work/save-setting.test.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Proves the write authority routes through the CANONICAL action route — the one
// the policy reader resolves as `policy.actionRoute` from the package's real
// published records — not a divergent second source. This is the L116 proof for
// the setting save: not "the pieces exist" but "the user's save fires the
// authority action with the exact envelope the owner expects."
//
// The chain under test is the live one:
//   things-to-store-and-run.json  (real contract)
//     → readNotificationsPolicyFromBoundary  (resolves policy.actionRoute)
//     → buildActionPayload / saveSetting      (assembles + sends the envelope)
//
// Domain literals (mode keys, target, action id) appear here ON PURPOSE: this is
// a test asserting the exact wire shape. The banned-literal rule governs the
// blind show/ and do-work/ SOURCE, never the proofs that pin their output.
//
// =============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';

import boundary from '../things-to-store-and-run.json';
import { readNotificationsPolicyFromBoundary } from '../read-data/read-notifications-policy';
import { buildActionPayload, saveSetting } from './save-setting';

// Mock the runtime-kit sender so the test asserts the routed request without
// performing real I/O. The real sender resolves to runtime-kit source via the
// vitest alias; here we replace just the one function the write authority calls.
const sendMock = vi.fn(async (_invocation: { target: string; payload: unknown }) => ({ ok: true }));
vi.mock('@bitfield/runtime-kit', () => ({
  sendRequestToBitfieldTarget: (invocation: { target: string; payload: unknown }) => sendMock(invocation),
}));

afterEach(() => {
  sendMock.mockClear();
});

describe('setting write authority routes through the canonical action route', () => {
  it('resolves policy.actionRoute straight from the real published records', () => {
    const policy = readNotificationsPolicyFromBoundary(boundary, 'focus');
    expect(policy.actionRoute).not.toBeNull();
    // The canonical route is the record-policy-action-graph route, NOT a second
    // descriptor-write copy — its id is the graph route's id.
    expect(policy.actionRoute).toEqual({
      id: 'notifications.action-route.update-workspace-policy',
      target: 'slot::workflow',
      valuePath: ['input', 'mode_id'],
      payloadTemplate: {
        operation: 'execute_definition',
        definition_id: 'action:update-workspace-notification-mode',
        // Response-control flags flow as DATA from the route's payload_defaults —
        // omitting them would let workflow default them to TRUE and echo full step
        // traces + output for a fire-and-forget mode set (serde defaults: api.rs).
        include_steps: false,
        include_output: false,
      },
    });
  });

  it('builds the exact owner execute envelope from route DATA', () => {
    const policy = readNotificationsPolicyFromBoundary(boundary, 'focus');
    const payload = buildActionPayload(policy.actionRoute!, 'focus');
    expect(payload).toEqual({
      operation: 'execute_definition',
      definition_id: 'action:update-workspace-notification-mode',
      include_steps: false,
      include_output: false,
      input: { mode_id: 'focus' },
    });
  });

  it('inserts the opaque option id verbatim at the route value path for any option', () => {
    const policy = readNotificationsPolicyFromBoundary(boundary, 'scheduled');
    const payload = buildActionPayload(policy.actionRoute!, 'scheduled') as {
      input: { mode_id: string };
    };
    expect(payload.input.mode_id).toBe('scheduled');
  });

  it('saveSetting sends the assembled envelope to the route target and reports success', async () => {
    const policy = readNotificationsPolicyFromBoundary(boundary, 'dnd');
    const result = await saveSetting(policy.actionRoute, 'dnd');

    expect(result).toEqual({ ok: true, optionId: 'dnd', reply: { ok: true } });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: 'action:update-workspace-notification-mode',
        include_steps: false,
        include_output: false,
        input: { mode_id: 'dnd' },
      },
    });
  });

  it('returns a read-only result and sends nothing when there is no route', async () => {
    const result = await saveSetting(null, 'focus');
    expect(result.ok).toBe(false);
    expect(result.optionId).toBe('focus');
    expect(result.error).toMatch(/read-only/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('never mutates the route or shares structure across two saves', async () => {
    const policy = readNotificationsPolicyFromBoundary(boundary, 'focus');
    const route = policy.actionRoute!;
    const before = JSON.stringify(route);
    await saveSetting(route, 'focus');
    await saveSetting(route, 'normal');
    expect(JSON.stringify(route)).toBe(before);
    const first = sendMock.mock.calls[0][0].payload as { input: { mode_id: string } };
    const second = sendMock.mock.calls[1][0].payload as { input: { mode_id: string } };
    expect(first.input.mode_id).toBe('focus');
    expect(second.input.mode_id).toBe('normal');
    expect(first).not.toBe(second);
  });
});
