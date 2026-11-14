import { describe, expect, it, vi } from '../../../test-helpers/vitest-shim.mjs';
import {
  buildProcessSessionSignalRequest,
  terminateProcessSession,
  type ProcessSessionCancellationReadback,
} from './terminate-process-session.ts';
import type { ProcessSessionSender } from './start-process-session.ts';

function reply(json: unknown): { payload: Uint8Array } {
  return { payload: new TextEncoder().encode(JSON.stringify(json)) };
}

function snapshot(
  state: 'running' | 'exited' | 'failed',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: 'session:exact',
    state,
    process: { termination_grace_ms: 37 },
    ...overrides,
  };
}

function reader(...values: ProcessSessionCancellationReadback[]) {
  let index = 0;
  return vi.fn(async () => values[Math.min(index++, values.length - 1)]);
}

describe('terminateProcessSession', () => {
  it('builds the existing process-session AppendSessionCommand wire shape', () => {
    expect(buildProcessSessionSignalRequest('compute.process_session', 'session:exact', 'terminate'))
      .toEqual({
        target: 'compute.process_session',
        payload: {
          operation: 'append_session_command',
          session_id: 'session:exact',
          command: { kind: 'send_process_signal', signal: 'terminate' },
        },
      });
    expect(buildProcessSessionSignalRequest('compute.process_session', 'session:exact', 'kill')
      .payload.command.signal).toBe('kill');
  });

  it('is idempotent for an already-terminal exact session and sends no command', async () => {
    const sender = vi.fn<ProcessSessionSender>();
    const waitForGrace = vi.fn(async () => undefined);
    const result = await terminateProcessSession({
      target: 'compute.process_session',
      sessionId: 'session:exact',
      sender,
      readback: reader({ status: 'found', snapshot: snapshot('exited') }),
      waitForGrace,
    });
    expect(result).toMatchObject({ status: 'already-terminal', snapshot: { state: 'exited' } });
    expect(sender).not.toHaveBeenCalled();
    expect(waitForGrace).not.toHaveBeenCalled();
  });

  it('returns session-missing without sending a blind signal', async () => {
    const sender = vi.fn<ProcessSessionSender>();
    const result = await terminateProcessSession({
      target: 'compute.process_session',
      sessionId: 'session:exact',
      sender,
      readback: reader({ status: 'missing' }),
      waitForGrace: vi.fn(async () => undefined),
    });
    expect(result).toEqual({ status: 'session-missing', phase: 'initial-readback' });
    expect(sender).not.toHaveBeenCalled();
  });

  it('sends terminate, waits exactly the descriptor-owned grace, and stops after terminal readback', async () => {
    const sender = vi.fn<ProcessSessionSender>(async () =>
      reply({ result: 'command_accepted', session_id: 'session:exact', snapshot: snapshot('running') }));
    const waitForGrace = vi.fn(async () => undefined);
    const readback = reader(
      { status: 'found', snapshot: snapshot('running') },
      { status: 'found', snapshot: snapshot('exited') },
    );
    const result = await terminateProcessSession({
      target: 'compute.process_session', sessionId: 'session:exact', sender, readback, waitForGrace,
    });
    expect(result).toMatchObject({ status: 'terminated', snapshot: { state: 'exited' } });
    expect(waitForGrace).toHaveBeenCalledOnce();
    expect(waitForGrace).toHaveBeenCalledWith(37);
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][0].payload).toMatchObject({
      operation: 'append_session_command',
      session_id: 'session:exact',
      command: { kind: 'send_process_signal', signal: 'terminate' },
    });
  });

  it('kills only after grace readback still proves the exact session is running', async () => {
    const sender = vi.fn<ProcessSessionSender>(async (request) =>
      reply({
        result: 'command_accepted',
        session_id: 'session:exact',
        // Hostile acknowledgement snapshot: this must not prove completion.
        snapshot: snapshot(request.payload.command && (request.payload.command as { signal?: string }).signal === 'terminate' ? 'exited' : 'running'),
      }));
    const readback = reader(
      { status: 'found', snapshot: snapshot('running') },
      { status: 'found', snapshot: snapshot('running') },
      { status: 'found', snapshot: snapshot('failed') },
    );
    const result = await terminateProcessSession({
      target: 'compute.process_session',
      sessionId: 'session:exact',
      sender,
      readback,
      waitForGrace: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ status: 'killed-after-grace', snapshot: { state: 'failed' } });
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls.map(([request]) =>
      (request.payload.command as { signal: string }).signal)).toEqual(['terminate', 'kill']);
    expect(readback).toHaveBeenCalledTimes(3);
  });

  it('returns rejected and does not trust a rejection acknowledgement snapshot as terminal proof', async () => {
    const sender = vi.fn<ProcessSessionSender>(async () =>
      reply({
        result: 'command_rejected',
        session_id: 'session:exact',
        reason: 'signal capability revoked',
        snapshot: snapshot('exited'),
      }));
    const readback = reader({ status: 'found', snapshot: snapshot('running') });
    const result = await terminateProcessSession({
      target: 'compute.process_session',
      sessionId: 'session:exact',
      sender,
      readback,
      waitForGrace: vi.fn(async () => undefined),
    });
    expect(result).toEqual({
      status: 'rejected', phase: 'terminate-command', reason: 'signal capability revoked',
    });
    expect(readback).toHaveBeenCalledOnce();
  });

  it('fails closed before signalling when exact identity or descriptor grace is unproven', async () => {
    for (const hostile of [
      snapshot('running', { session_id: 'session:other' }),
      snapshot('running', { process: {} }),
      snapshot('running', { process: { termination_grace_ms: 0 } }),
      snapshot('paused' as never),
    ]) {
      const sender = vi.fn<ProcessSessionSender>();
      const result = await terminateProcessSession({
        target: 'compute.process_session',
        sessionId: 'session:exact',
        sender,
        readback: reader({ status: 'found', snapshot: hostile }),
        waitForGrace: vi.fn(async () => undefined),
      });
      expect(result.status).toBe('readback-insufficient');
      expect(sender).not.toHaveBeenCalled();
    }
  });

  it('never escalates to kill when the after-terminate readback is missing or insufficient', async () => {
    for (const afterTerminate of [
      { status: 'missing' } as const,
      { status: 'insufficient', reason: 'feed cursor unavailable' } as const,
    ]) {
      const sender = vi.fn<ProcessSessionSender>(async () =>
        reply({ result: 'command_accepted', session_id: 'session:exact' }));
      const result = await terminateProcessSession({
        target: 'compute.process_session',
        sessionId: 'session:exact',
        sender,
        readback: reader(
          { status: 'found', snapshot: snapshot('running') },
          afterTerminate,
        ),
        waitForGrace: vi.fn(async () => undefined),
      });
      expect(result.status).toBe(afterTerminate.status === 'missing' ? 'session-missing' : 'readback-insufficient');
      expect(sender).toHaveBeenCalledOnce();
    }
  });

  it('does not call a polling loop when kill acknowledgement lacks terminal proof', async () => {
    const sender = vi.fn<ProcessSessionSender>(async () =>
      reply({ result: 'command_accepted', session_id: 'session:exact' }));
    const readback = reader(
      { status: 'found', snapshot: snapshot('running') },
      { status: 'found', snapshot: snapshot('running') },
      { status: 'found', snapshot: snapshot('running') },
    );
    const result = await terminateProcessSession({
      target: 'compute.process_session',
      sessionId: 'session:exact',
      sender,
      readback,
      waitForGrace: vi.fn(async () => undefined),
    });
    expect(result).toEqual({
      status: 'readback-insufficient',
      phase: 'after-kill-readback',
      reason: 'kill was acknowledged but exact-session readback is still nonterminal',
    });
    expect(readback).toHaveBeenCalledTimes(3);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('fails closed on malformed, mismatched, or lost command replies', async () => {
    for (const commandReply of [
      reply({ result: 'command_accepted', session_id: 'session:other' }),
      reply({ result: 'mystery', session_id: 'session:exact' }),
      { payload: new TextEncoder().encode('not-json') },
    ]) {
      const sender = vi.fn<ProcessSessionSender>(async () => commandReply);
      const result = await terminateProcessSession({
        target: 'compute.process_session',
        sessionId: 'session:exact',
        sender,
        readback: reader({ status: 'found', snapshot: snapshot('running') }),
        waitForGrace: vi.fn(async () => undefined),
      });
      expect(result).toMatchObject({ status: 'readback-insufficient', phase: 'terminate-command' });
    }
  });
});
