import {
  decodeProcessSessionReply,
  type ProcessSessionSender,
} from '../envelope-client/start-process-session.ts';

type TerminalProcessSessionState = 'exited' | 'failed';
type ProcessSessionState = 'running' | TerminalProcessSessionState;

export interface ProcessSessionCancellationSnapshot {
  readonly sessionId: string;
  readonly state: ProcessSessionState;
  /** Present only while running. It is read from the admitted process descriptor,
   * never supplied as a caller-selected cancellation timeout. */
  readonly terminationGraceMs: number | null;
}

export type ProcessSessionCancellationReadback =
  | { readonly status: 'found'; readonly snapshot: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'insufficient'; readonly reason: string };

/** Exact-session owner readback. The adapter invokes this at most three times:
 * before terminate, once after the descriptor-owned grace, and once after kill. */
export type ProcessSessionCancellationReader = (
  sessionId: string,
) => Promise<ProcessSessionCancellationReadback>;

/** Injected grace boundary. Production callers may sleep until the deadline;
 * deterministic callers/tests may advance their own clock. */
export type ProcessSessionGraceWaiter = (graceMs: number) => Promise<void>;

export type ProcessSessionCancellationPhase =
  | 'initial-readback'
  | 'terminate-command'
  | 'grace-wait'
  | 'after-terminate-readback'
  | 'kill-command'
  | 'after-kill-readback';

export type ProcessSessionCancellationResult =
  | {
      readonly status: 'already-terminal';
      readonly snapshot: ProcessSessionCancellationSnapshot;
    }
  | {
      readonly status: 'session-missing';
      readonly phase: Extract<
        ProcessSessionCancellationPhase,
        'initial-readback' | 'after-terminate-readback' | 'after-kill-readback'
      >;
    }
  | {
      readonly status: 'rejected';
      readonly phase: 'terminate-command' | 'kill-command';
      readonly reason: string;
    }
  | {
      readonly status: 'terminated';
      readonly snapshot: ProcessSessionCancellationSnapshot;
    }
  | {
      readonly status: 'killed-after-grace';
      readonly snapshot: ProcessSessionCancellationSnapshot;
    }
  | {
      readonly status: 'readback-insufficient';
      readonly phase: ProcessSessionCancellationPhase;
      readonly reason: string;
    };

export interface TerminateProcessSessionOptions {
  readonly target: string;
  readonly sessionId: string;
  readonly sender: ProcessSessionSender;
  readonly readback: ProcessSessionCancellationReader;
  readonly waitForGrace: ProcessSessionGraceWaiter;
}

export interface ProcessSessionSignalRequest {
  readonly target: string;
  readonly payload: Record<string, unknown> & {
    readonly operation: 'append_session_command';
    readonly session_id: string;
    readonly command: {
      readonly kind: 'send_process_signal';
      readonly signal: 'terminate' | 'kill';
    };
  };
}

type DecodedReadback =
  | { readonly status: 'found'; readonly snapshot: ProcessSessionCancellationSnapshot }
  | { readonly status: 'missing' }
  | { readonly status: 'insufficient'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeReadback(
  readback: ProcessSessionCancellationReadback,
  expectedSessionId: string,
): DecodedReadback {
  if (readback.status !== 'found') return readback;
  if (!isRecord(readback.snapshot)) {
    return { status: 'insufficient', reason: 'process-session readback snapshot is not an object' };
  }

  const sessionId = readback.snapshot.session_id;
  if (sessionId !== expectedSessionId) {
    return {
      status: 'insufficient',
      reason: `process-session readback did not prove exact session ${expectedSessionId}`,
    };
  }

  const state = readback.snapshot.state;
  if (state !== 'running' && state !== 'exited' && state !== 'failed') {
    return { status: 'insufficient', reason: 'process-session readback has an unknown state' };
  }

  if (state !== 'running') {
    return {
      status: 'found',
      snapshot: { sessionId, state, terminationGraceMs: null },
    };
  }

  const process = readback.snapshot.process;
  const terminationGraceMs = isRecord(process) ? process.termination_grace_ms : undefined;
  if (
    typeof terminationGraceMs !== 'number'
    || !Number.isSafeInteger(terminationGraceMs)
    || terminationGraceMs <= 0
  ) {
    return {
      status: 'insufficient',
      reason: 'running process-session readback lacks a valid descriptor-owned termination_grace_ms',
    };
  }

  return {
    status: 'found',
    snapshot: { sessionId, state, terminationGraceMs },
  };
}

async function readExactSession(
  readback: ProcessSessionCancellationReader,
  sessionId: string,
): Promise<DecodedReadback> {
  try {
    return decodeReadback(await readback(sessionId), sessionId);
  } catch (error) {
    return { status: 'insufficient', reason: `process-session readback failed: ${errorMessage(error)}` };
  }
}

export function buildProcessSessionSignalRequest(
  target: string,
  sessionId: string,
  signal: 'terminate' | 'kill',
): ProcessSessionSignalRequest {
  if (target.trim().length === 0) throw new Error('process-session target must not be empty');
  if (sessionId.trim().length === 0) throw new Error('process-session sessionId must not be empty');
  return {
    target,
    payload: {
      operation: 'append_session_command',
      session_id: sessionId,
      command: { kind: 'send_process_signal', signal },
    },
  };
}

async function sendSignal(
  options: TerminateProcessSessionOptions,
  signal: 'terminate' | 'kill',
): Promise<{ status: 'accepted' } | { status: 'rejected'; reason: string } | { status: 'insufficient'; reason: string }> {
  try {
    const reply = decodeProcessSessionReply(await options.sender(
      buildProcessSessionSignalRequest(options.target, options.sessionId, signal),
    ));
    if (reply.session_id !== options.sessionId) {
      return {
        status: 'insufficient',
        reason: `process-session command reply did not name exact session ${options.sessionId}`,
      };
    }
    if (reply.result === 'command_accepted') return { status: 'accepted' };
    if (reply.result === 'command_rejected') {
      return {
        status: 'rejected',
        reason: typeof reply.reason === 'string' && reply.reason.length > 0
          ? reply.reason
          : 'process-session command rejected without a reason',
      };
    }
    return {
      status: 'insufficient',
      reason: 'process-session command reply was neither accepted nor rejected',
    };
  } catch (error) {
    return { status: 'insufficient', reason: `process-session command reply failed: ${errorMessage(error)}` };
  }
}

/**
 * Terminate one exact process session without introducing a second process owner.
 *
 * The adapter performs a fixed sequence, never a polling loop:
 * read -> terminate -> one descriptor-owned grace wait -> read -> optional kill -> read.
 * Command acknowledgement proves only admission of signal intent. Only the injected
 * exact-session readback boundary may prove a terminal result.
 */
export async function terminateProcessSession(
  options: TerminateProcessSessionOptions,
): Promise<ProcessSessionCancellationResult> {
  const initial = await readExactSession(options.readback, options.sessionId);
  if (initial.status === 'missing') {
    return { status: 'session-missing', phase: 'initial-readback' };
  }
  if (initial.status === 'insufficient') {
    return { status: 'readback-insufficient', phase: 'initial-readback', reason: initial.reason };
  }
  if (initial.snapshot.state !== 'running') {
    return { status: 'already-terminal', snapshot: initial.snapshot };
  }

  const terminate = await sendSignal(options, 'terminate');
  if (terminate.status === 'rejected') {
    return { status: 'rejected', phase: 'terminate-command', reason: terminate.reason };
  }
  if (terminate.status === 'insufficient') {
    return { status: 'readback-insufficient', phase: 'terminate-command', reason: terminate.reason };
  }

  const graceMs = initial.snapshot.terminationGraceMs;
  if (graceMs === null) {
    return {
      status: 'readback-insufficient',
      phase: 'initial-readback',
      reason: 'running process-session readback did not retain its descriptor-owned grace',
    };
  }
  try {
    await options.waitForGrace(graceMs);
  } catch (error) {
    return {
      status: 'readback-insufficient',
      phase: 'grace-wait',
      reason: `process-session grace wait failed: ${errorMessage(error)}`,
    };
  }

  const afterTerminate = await readExactSession(options.readback, options.sessionId);
  if (afterTerminate.status === 'missing') {
    return { status: 'session-missing', phase: 'after-terminate-readback' };
  }
  if (afterTerminate.status === 'insufficient') {
    return {
      status: 'readback-insufficient',
      phase: 'after-terminate-readback',
      reason: afterTerminate.reason,
    };
  }
  if (afterTerminate.snapshot.state !== 'running') {
    return { status: 'terminated', snapshot: afterTerminate.snapshot };
  }

  const kill = await sendSignal(options, 'kill');
  if (kill.status === 'rejected') {
    return { status: 'rejected', phase: 'kill-command', reason: kill.reason };
  }
  if (kill.status === 'insufficient') {
    return { status: 'readback-insufficient', phase: 'kill-command', reason: kill.reason };
  }

  const afterKill = await readExactSession(options.readback, options.sessionId);
  if (afterKill.status === 'missing') {
    return { status: 'session-missing', phase: 'after-kill-readback' };
  }
  if (afterKill.status === 'insufficient') {
    return {
      status: 'readback-insufficient',
      phase: 'after-kill-readback',
      reason: afterKill.reason,
    };
  }
  if (afterKill.snapshot.state !== 'running') {
    return { status: 'killed-after-grace', snapshot: afterKill.snapshot };
  }
  return {
    status: 'readback-insufficient',
    phase: 'after-kill-readback',
    reason: 'kill was acknowledged but exact-session readback is still nonterminal',
  };
}
