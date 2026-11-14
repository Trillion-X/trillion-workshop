import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import {
  buildProcessSessionStartRequest,
  startProcessSession,
  decodeProcessSessionReply,
  type ProcessSessionSender,
} from '../envelope-client/start-process-session.ts';

function reply(json: unknown): { payload: Uint8Array } {
  return { payload: new TextEncoder().encode(JSON.stringify(json)) };
}

const DESCRIPTOR = {
  process: {
    argv: ['codex', 'exec', '--', 'hi'],
    cwd: null,
    timeout_ms: 300_000,
    termination_grace_ms: 1_000,
    expected_termination: null,
    env: {},
    inputs: [],
    input_trees: [],
    outputs: [],
    containment: {
      kind: 'descendant_effect_contained',
      pipe_eof_timeout_ms: 1_000,
      publications: [],
    },
    capture_fds: [1, 2],
    collected_files: [],
  },
  session_settings: { text_grid: null },
} as const;

describe('startProcessSession', () => {
  it('sends operation:start_session with the descriptor to the given target', async () => {
    const seen: { target: string; payload: Record<string, unknown> }[] = [];
    const sender: ProcessSessionSender = async (req) => {
      seen.push(req);
      return reply({ result: 'session_started', session_id: 's1', snapshot: { event_feed_address: 'addr:feed', event_stream_address: 'addr:stream' } });
    };
    const out = await startProcessSession(DESCRIPTOR as never, { target: 'compute.process_session', sender });
    expect(seen).toHaveLength(1);
    expect(seen[0].target).toBe('compute.process_session');
    expect(seen[0].payload.operation).toBe('start_session');
    expect(seen[0].payload.descriptor).toBe(DESCRIPTOR);
    expect(seen[0].payload).not.toHaveProperty('idempotency_key');
    expect(out).toEqual({ sessionId: 's1', eventFeedAddress: 'addr:feed', eventStreamAddress: 'addr:stream', terminalOutputAddress: null });
  });

  it('sends a bounded caller-owned idempotency key without changing the descriptor', () => {
    expect(buildProcessSessionStartRequest(DESCRIPTOR as never, {
      target: 'compute.process_session',
      idempotencyKey: 'founder-action:FOG-019:claim-1',
    })).toEqual({
      target: 'compute.process_session',
      payload: {
        operation: 'start_session',
        descriptor: DESCRIPTOR,
        idempotency_key: 'founder-action:FOG-019:claim-1',
      },
    });
    expect(() => buildProcessSessionStartRequest(DESCRIPTOR as never, {
      target: 'compute.process_session',
      idempotencyKey: 'line\nbreak',
    })).toThrow(/control characters/);
  });

  it('reads session_id + both feed addresses from the snapshot when top-level session_id is absent', async () => {
    const sender: ProcessSessionSender = async () =>
      reply({ result: 'session_started', snapshot: { session_id: 's2', event_feed_address: 'addr:2', event_stream_address: 'addr:2s' } });
    const out = await startProcessSession(DESCRIPTOR as never, { target: 't', sender });
    expect(out).toEqual({ sessionId: 's2', eventFeedAddress: 'addr:2', eventStreamAddress: 'addr:2s', terminalOutputAddress: null });
  });

  it('returns null feed addresses when the reply omits them (non-streaming/degraded)', async () => {
    const sender: ProcessSessionSender = async () => reply({ result: 'session_started', session_id: 's3', snapshot: {} });
    const out = await startProcessSession(DESCRIPTOR as never, { target: 't', sender });
    expect(out).toEqual({ sessionId: 's3', eventFeedAddress: null, eventStreamAddress: null, terminalOutputAddress: null });
  });

  it('captures the authoritative terminal_output_address from the snapshot when present', async () => {
    const sender: ProcessSessionSender = async () =>
      reply({ result: 'session_started', session_id: 's4', snapshot: { event_feed_address: 'addr:4', event_stream_address: 'addr:4s', terminal_output_address: 'addr:4term' } });
    const out = await startProcessSession(DESCRIPTOR as never, { target: 't', sender });
    expect(out).toEqual({ sessionId: 's4', eventFeedAddress: 'addr:4', eventStreamAddress: 'addr:4s', terminalOutputAddress: 'addr:4term' });
  });

  it('throws the engine reason when result is not session_started', async () => {
    const sender: ProcessSessionSender = async () => reply({ result: 'rejected', reason: 'budget exhausted' });
    await expect(startProcessSession(DESCRIPTOR as never, { target: 't', sender })).rejects.toThrow('budget exhausted');
  });

  it('throws when session_started but no session_id anywhere', async () => {
    const sender: ProcessSessionSender = async () => reply({ result: 'session_started', snapshot: {} });
    await expect(startProcessSession(DESCRIPTOR as never, { target: 't', sender })).rejects.toThrow('no session_id');
  });

  it('decodeProcessSessionReply rejects a non-envelope / non-JSON reply', () => {
    expect(() => decodeProcessSessionReply(null)).toThrow(/no byte payload/);
    expect(() => decodeProcessSessionReply({})).toThrow(/no byte payload/);
    expect(() => decodeProcessSessionReply({ payload: new TextEncoder().encode('not json') }))
      .toThrow(/invalid JSON/);
  });
});
