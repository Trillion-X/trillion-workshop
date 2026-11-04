//
// One payload-agnostic settlement machine for every Visual Database mutation.
// Transport acceptance is never success. Success requires the same expected
// projection to be observed in the owner feed and in an independent current-
// value read, in that order. The machine knows no record, field, status, view,
// Formula, or UI vocabulary.

export type MutationSettlementPhase =
  | 'attempted'
  | 'transport-accepted'
  | 'transport-uncertain'
  | 'feed-observed'
  | 'direct-readback'
  | 'saved'
  | 'conflict'
  | 'failed'
  | 'timeout'
  | 'stale'
  | 'deduplicated';

export type MutationSettlementState =
  | 'saved'
  | 'conflict'
  | 'failed'
  | 'timeout'
  | 'stale';

export interface MutationSettlementTransition {
  attemptId: string;
  scope: string;
  phase: MutationSettlementPhase;
  elapsedMs: number;
}

export interface MutationSettlementPolicy {
  schemaVersion: 1;
  revision: string;
  activeRevision: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface MutationSettlementAttempt<Expected, Observed> {
  attemptId: string;
  scope: string;
  /**
   * Every independently addressed owner fact this attempt can change.
   * Overlapping attempts therefore share authority even when one is a batch
   * and the other is a single-address write. Defaults to `[scope]`.
   */
  authorityKeys?: readonly string[];
  expected: Expected;
  write: () => Promise<void>;
  observeFeed: () => Observed | null | Promise<Observed | null>;
  readCurrent: () => Observed | null | Promise<Observed | null>;
  matches: (observed: Observed, expected: Expected) => boolean;
  classifyCurrent?: (
    observed: Observed | null,
    expected: Expected,
  ) => 'conflict' | 'failed' | null;
  policy: MutationSettlementPolicy;
  onTransition?: (transition: MutationSettlementTransition) => void;
}

export type MutationSettlementObservationStatus =
  | 'unobserved'
  | 'absent'
  | 'different'
  | 'matched'
  | 'error';

export interface MutationSettlementObservation<Observed> {
  status: MutationSettlementObservationStatus;
  value: Observed | null;
  error?: unknown;
}

export interface MutationSettlementTerminalObservation<Observed> {
  transport: {
    status: 'not-attempted' | 'accepted' | 'uncertain';
    error?: unknown;
  };
  feed: MutationSettlementObservation<Observed>;
  readback: MutationSettlementObservation<Observed>;
}

export interface MutationSettlementResult<Observed = unknown> {
  attemptId: string;
  scope: string;
  state: MutationSettlementState;
  transitions: readonly MutationSettlementTransition[];
  reusedAcceptance: boolean;
  /**
   * The last owner observations used by the coordinator before it assigned the
   * sole terminal state. Values remain opaque to this primitive; adapters may
   * project them for callers without reading or classifying owner truth again.
   */
  terminalObservation: MutationSettlementTerminalObservation<Observed>;
  error?: unknown;
}

export interface MutationSettlementClock {
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

const REAL_CLOCK: MutationSettlementClock = {
  now: Date.now,
  wait: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${context} contains unknown member${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`);
  }
}

/**
 * Decodes one owner-provided, versioned policy set and selects its sole active
 * descriptor. Revision selection is DATA; this primitive only validates the
 * generic temporal contract.
 */
export function decodeMutationSettlementPolicy(input: unknown): MutationSettlementPolicy {
  const set = recordOf(input);
  if (!set) throw new Error('Mutation settlement policy DATA is required.');
  rejectUnknownKeys(
    set,
    ['kind', 'schema_version', 'active_revision', 'descriptors'],
    'Mutation settlement policy DATA',
  );
  if (set.kind !== 'mutation-settlement.policy-set') {
    throw new Error('Mutation settlement policy DATA has an unknown kind.');
  }
  if (set.schema_version !== 1) {
    throw new Error('Mutation settlement policy DATA has an unknown schema version.');
  }
  if (!nonEmpty(set.active_revision)) {
    throw new Error('Mutation settlement policy DATA requires one active revision.');
  }
  if (!Array.isArray(set.descriptors)) {
    throw new Error('Mutation settlement policy DATA requires a descriptor list.');
  }
  const descriptors = set.descriptors.map(recordOf);
  if (descriptors.some((descriptor) => descriptor === null)) {
    throw new Error('Mutation settlement policy DATA contains an invalid descriptor.');
  }
  descriptors.forEach((descriptor) => rejectUnknownKeys(
    descriptor!,
    ['revision', 'timeout_ms', 'poll_interval_ms'],
    'Mutation settlement policy DATA descriptor',
  ));
  const revisions = descriptors.map((descriptor) => descriptor!.revision);
  if (revisions.some((revision) => !nonEmpty(revision))
    || new Set(revisions).size !== revisions.length) {
    throw new Error('Mutation settlement policy DATA requires unique non-empty revisions.');
  }
  const active = descriptors.filter((descriptor) => descriptor!.revision === set.active_revision);
  if (active.length !== 1) {
    throw new Error('Mutation settlement policy DATA does not resolve exactly one active revision.');
  }
  const descriptor = active[0]!;
  if (!positiveFinite(descriptor.timeout_ms) || !positiveFinite(descriptor.poll_interval_ms)) {
    throw new Error('Mutation settlement policy DATA requires positive finite timing values.');
  }
  return {
    schemaVersion: 1,
    revision: descriptor.revision as string,
    activeRevision: set.active_revision,
    timeoutMs: descriptor.timeout_ms,
    pollIntervalMs: descriptor.poll_interval_ms,
  };
}

function validateAttemptPolicy(policy: unknown): asserts policy is MutationSettlementPolicy {
  const candidate = recordOf(policy);
  if (!candidate) throw new Error('Mutation settlement attempt policy is required.');
  rejectUnknownKeys(
    candidate,
    ['schemaVersion', 'revision', 'activeRevision', 'timeoutMs', 'pollIntervalMs'],
    'Mutation settlement attempt policy',
  );
  if (candidate.schemaVersion !== 1) {
    throw new Error('Mutation settlement attempt policy has an unknown schema version.');
  }
  if (!nonEmpty(candidate.revision) || !nonEmpty(candidate.activeRevision)) {
    throw new Error('Mutation settlement attempt policy requires revision identity.');
  }
  if (candidate.revision !== candidate.activeRevision) {
    throw new Error('Mutation settlement attempt policy revision is stale.');
  }
  if (!positiveFinite(candidate.timeoutMs) || !positiveFinite(candidate.pollIntervalMs)) {
    throw new Error('Mutation settlement attempt policy requires positive finite timing values.');
  }
}

/**
 * Coordinates independently addressed mutation attempts.
 *
 * - `authorityKeys` establish latest-attempt authority. A newer attempt
 *   touching any shared key makes an older in-flight reply stale.
 * - owner feed + independent current readback establish idempotency. Retrying
 *   an already-projected mutation cannot write it again, including after a
 *   remount or coordinator restart.
 * - expected/observed values stay opaque. Callers own projection matching.
 */
export class MutationSettlementCoordinator {
  private readonly clock: MutationSettlementClock;
  private readonly latestByScope = new Map<string, string>();

  constructor(clock: MutationSettlementClock = REAL_CLOCK) {
    this.clock = clock;
  }

  async settle<Expected, Observed>(
    attempt: MutationSettlementAttempt<Expected, Observed>,
  ): Promise<MutationSettlementResult<Observed>> {
    // Policy is owner DATA and must be valid before any owner observation or
    // transport function can execute.
    validateAttemptPolicy(attempt.policy);
    const startedAt = this.clock.now();
    const transitions: MutationSettlementTransition[] = [];
    const transition = (phase: MutationSettlementPhase) => {
      const row = {
        attemptId: attempt.attemptId,
        scope: attempt.scope,
        phase,
        elapsedMs: Math.max(0, this.clock.now() - startedAt),
      };
      transitions.push(row);
      attempt.onTransition?.(row);
    };
    let transportObservation: MutationSettlementTerminalObservation<Observed>['transport'] = {
      status: 'not-attempted',
    };
    let feedObservation: MutationSettlementObservation<Observed> = {
      status: 'unobserved',
      value: null,
    };
    let readbackObservation: MutationSettlementObservation<Observed> = {
      status: 'unobserved',
      value: null,
    };
    const captureObservation = (
      value: Observed | null,
    ): MutationSettlementObservation<Observed> => ({
      status: value === null
        ? 'absent'
        : attempt.matches(value, attempt.expected) ? 'matched' : 'different',
      value,
    });
    const observeFeed = async (): Promise<Observed | null> => {
      try {
        const value = await attempt.observeFeed();
        feedObservation = captureObservation(value);
        return value;
      } catch (error) {
        feedObservation = { status: 'error', value: null, error };
        throw error;
      }
    };
    const readCurrent = async (): Promise<Observed | null> => {
      try {
        const value = await attempt.readCurrent();
        readbackObservation = captureObservation(value);
        return value;
      } catch (error) {
        readbackObservation = { status: 'error', value: null, error };
        throw error;
      }
    };
    const result = (
      state: MutationSettlementState,
      reusedAcceptance = false,
      error?: unknown,
    ): MutationSettlementResult<Observed> => ({
      attemptId: attempt.attemptId,
      scope: attempt.scope,
      state,
      transitions,
      reusedAcceptance,
      terminalObservation: {
        transport: transportObservation,
        feed: feedObservation,
        readback: readbackObservation,
      },
      ...(error === undefined ? {} : { error }),
    });
    const authorityKeys = [...new Set(attempt.authorityKeys ?? [attempt.scope])];
    if (authorityKeys.length === 0 || authorityKeys.some((key) => key.length === 0)) {
      throw new Error('Mutation settlement requires at least one non-empty authority key.');
    }
    const isCurrent = () => authorityKeys.every(
      (key) => this.latestByScope.get(key) === attempt.attemptId,
    );
    const policy = attempt.policy;

    authorityKeys.forEach((key) => this.latestByScope.set(key, attempt.attemptId));
    transition('attempted');

    let preflightFeed: Observed | null = null;
    let preflightCurrent: Observed | null = null;
    try {
      preflightFeed = await observeFeed();
    } catch {
      // A feed failure cannot establish prior acceptance. The guarded write
      // path below remains safe because independent owner truth is also read.
    }
    if (!isCurrent()) {
      transition('stale');
      return result('stale');
    }
    const feedAlreadyMatches = preflightFeed !== null
      && attempt.matches(preflightFeed, attempt.expected);
    if (feedAlreadyMatches) transition('feed-observed');
    try {
      preflightCurrent = await readCurrent();
      transition('direct-readback');
    } catch {
      // A failed preflight read cannot establish prior acceptance. Continue
      // through the guarded write path and report its observable outcome.
    }
    if (!isCurrent()) {
      transition('stale');
      return result('stale');
    }
    const currentAlreadyMatches = preflightCurrent !== null
      && attempt.matches(preflightCurrent, attempt.expected);
    if (feedAlreadyMatches && currentAlreadyMatches) {
      transition('deduplicated');
      transition('saved');
      return result('saved', true);
    }

    // Durable owner truth can outrun its projection. Once independent current
    // truth is exact, another transport write is forbidden: poll only the feed,
    // then re-read current truth after the feed catches up.
    if (currentAlreadyMatches) {
      while (this.clock.now() - startedAt <= policy.timeoutMs) {
        let observed: Observed | null;
        try {
          observed = await observeFeed();
        } catch (error) {
          transition('failed');
          return result('failed', true, error);
        }
        if (!isCurrent()) {
          transition('stale');
          return result('stale', true);
        }
        if (observed !== null && attempt.matches(observed, attempt.expected)) {
          transition('feed-observed');
          let confirmed: Observed | null;
          try {
            confirmed = await readCurrent();
          } catch (error) {
            transition('failed');
            return result('failed', true, error);
          }
          if (!isCurrent()) {
            transition('stale');
            return result('stale', true);
          }
          transition('direct-readback');
          if (confirmed !== null && attempt.matches(confirmed, attempt.expected)) {
            transition('deduplicated');
            transition('saved');
            return result('saved', true);
          }
          transition('conflict');
          return result('conflict', true);
        }
        await this.clock.wait(policy.pollIntervalMs);
      }
      transition('timeout');
      return result('timeout', true);
    }

    let writeError: unknown;
    try {
      await attempt.write();
      transportObservation = { status: 'accepted' };
      transition('transport-accepted');
    } catch (error) {
      // The transport reply may be lost after the owner committed. Continue
      // through feed + independent readback before classifying the attempt.
      writeError = error;
      transportObservation = { status: 'uncertain', error };
      transition('transport-uncertain');
    }
    if (!isCurrent()) {
      transition('stale');
      return result('stale');
    }
    if (writeError !== undefined && attempt.classifyCurrent) {
      let afterWrite: Observed | null;
      try {
        afterWrite = await readCurrent();
      } catch {
        afterWrite = null;
      }
      if (!isCurrent()) {
        transition('stale');
        return result('stale');
      }
      transition('direct-readback');
      const classification = attempt.classifyCurrent(afterWrite, attempt.expected);
      if (classification === 'conflict') {
        transition('conflict');
        return result('conflict', false, writeError);
      }
    }

    let feedMatched = false;
    while (this.clock.now() - startedAt <= policy.timeoutMs) {
      let observed: Observed | null;
      try {
        observed = await observeFeed();
      } catch (error) {
        transition('failed');
        return result('failed', false, error);
      }
      if (!isCurrent()) {
        transition('stale');
        return result('stale');
      }
      if (observed !== null && attempt.matches(observed, attempt.expected)) {
        feedMatched = true;
        transition('feed-observed');
        break;
      }
      await this.clock.wait(policy.pollIntervalMs);
    }
    if (!feedMatched) {
      if (writeError !== undefined) {
        transition('failed');
        return result('failed', false, writeError);
      }
      transition('timeout');
      return result('timeout');
    }

    let current: Observed | null;
    try {
      current = await readCurrent();
    } catch (error) {
      transition('failed');
      return result('failed', false, error);
    }
    if (!isCurrent()) {
      transition('stale');
      return result('stale');
    }
    transition('direct-readback');
    if (current === null || !attempt.matches(current, attempt.expected)) {
      transition('conflict');
      return result('conflict', false, writeError);
    }

    transition('saved');
    return result('saved', false, writeError);
  }
}
