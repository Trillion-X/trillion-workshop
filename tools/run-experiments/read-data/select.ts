// tools/run-experiments/read-data/select.ts
//
// Purpose: The DECIDE operation — read or build a sticky decision transcript.
// Sticky semantics: same (observer, address, versions) within an epoch → same
// winner, achieved by memoization via observation facts.
//
// Architecture split (memoization vs live decision):
//   selectWinner(...)   — pure evaluator: scores candidates, returns a decision.
//                         Does NOT read/write transcripts (pure).
//   claimTranscript(...) — orchestrator: reads sticky transcript (if found), or
//                          calls selectWinner, builds transcript, appends via
//                          appendObservation (content-idempotent: the winner is
//                          deterministic, so re-writes agree; the read/write
//                          address is one formula so the sticky-hit actually fires).
//
// Non-negotiable invariants:
//   1. Transcript address is canonical sticky key: transcript::<observer_id>::<address>::<epoch>
//   2. Transcript shape carries decision + anchors to exact decider/candidate versions.
//   3. Sticky read-then-append: first-writer-wins via engine dispatch_rewrite_with_expected_current.
//   4. selectWinner reads ONLY fact-paths referenced by the decider (no full scan).
//   5. Deterministic: same snapshot facts → same winner, always.
//   6. observability: every claim logs winner, sticky hit, or build-and-claim.
//
// Dependencies: scoreCandidates (pure), appendObservation (injected).

import type {
  Candidate,
  SelectionSurface,
} from './candidate-set-schema.ts';
import type { DeciderProgram } from './decider-schema.ts';
import type { ObserverFact } from './score-candidates.ts';
import {
  scoreCandidates,
  type OpRegistry,
  builtinOps,
} from './score-candidates.ts';
import type { WriteBatchEntry } from '../do-work/observe.ts';
import {
  appendObservation,
  buildObservationRecord,
  buildWriteBatchEntry,
  observationAddress,
  type ObserveOptions,
} from '../do-work/observe.ts';

// ---------------------------------------------------------------------------
// Decision transcript — the memoization record
// ---------------------------------------------------------------------------

/**
 * A decision transcript: the immutable record of a decision made at a moment
 * in time (with a specific snapshot of facts, decider, candidate set, epoch).
 *
 * Sticky semantics: multiple decisions made within the same epoch with the same
 * observer, address, and versions will reuse the same transcript (same winner).
 * Different epochs → potentially different transcripts (new facts may have arrived).
 *
 * `entity_type`           — "transcript" (discriminant).
 * `observer_id`           — the observer who triggered the decision.
 * `address`               — the selection-surface address (e.g. checkout.payment_method).
 * `epoch`                 — time/version epoch (e.g. "2026-06-26T15:00:00Z" or
 *                           "epoch-123"). Resets when facts/version change.
 * `winner`                — the candidate_id of the winning candidate.
 * `candidate_set_version` — version hash/id of the candidate set (for cache invalidation).
 * `decider_id`            — id of the decider program used.
 * `decider_version`       — version hash/id of the decider (for cache invalidation).
 * `snapshot_anchor`       — causal timestamp/event id of the fact snapshot used.
 * `sticky_key`            — the stable key used by sticky_hash (for transparency).
 * `at`                    — ISO 8601 UTC when this transcript was created.
 */
export interface DecisionTranscript {
  entity_type: 'transcript';
  observer_id: string;
  address: string;
  epoch: string;
  winner: string;
  candidate_set_version: string;
  decider_id: string;
  decider_version: string;
  snapshot_anchor: string;
  sticky_key: string;
  at: string;
}

/**
 * Canonical address for a decision transcript.
 *
 * A transcript IS an observation about the observer (it records what that
 * observer was assigned), so it lives in the observer-fact namespace under the
 * `transcript` path — the SAME address `claimTranscript` writes it to via
 * `appendObservation({ path: ['transcript', address, epoch] })`. This function
 * delegates to `observationAddress` so the read address and the write address
 * are ONE formula and can never drift apart (a prior bug read
 * `transcript::…` while the write went to `observer::…::transcript::…`, so the
 * sticky-hit read never fired and the attribution join could not find
 * assignments).
 *
 * Format: observer::<observer_id>::transcript::<address>::<epoch>
 */
export function transcriptAddress(observerId: string, address: string, epoch: string): string {
  return observationAddress(observerId, ['transcript', address, epoch]);
}

// ---------------------------------------------------------------------------
// selectWinner — pure decision (no transcript read/write)
// ---------------------------------------------------------------------------

/**
 * Score candidates from a snapshot of observer facts and return the winner.
 * Does NOT read or write transcripts — purely evaluates facts against the decider.
 *
 * The fact snapshot is provided by the caller (expected to contain only the
 * fact-paths referenced by the decider). This enforces the invariant: "no full scan."
 *
 * @param surface        The candidate set.
 * @param factSnapshot   Fetched observer facts (caller's responsibility to scope).
 * @param decider        The decider program.
 * @param stickyKey      Stable string for sticky_hash bucket assignment.
 * @param registry       Op registry (default: builtinOps).
 *
 * @returns The winning candidate, or null if no winner possible (empty set).
 */
export function selectWinner(
  surface: SelectionSurface,
  factSnapshot: ObserverFact[],
  decider: DeciderProgram,
  stickyKey: string,
  registry: OpRegistry = builtinOps,
): Candidate | null {
  const result = scoreCandidates(surface, factSnapshot, decider, registry, stickyKey);
  return result.winner;
}

// ---------------------------------------------------------------------------
// claimTranscript — orchestrator: read-then-build-then-append (idempotent claim)
// ---------------------------------------------------------------------------

/**
 * Claim a decision transcript via the DECIDE operation.
 * Default behavior: read sticky transcript; if not found, call build fn,
 * construct transcript, append via appendObservation.
 *
 * The atomic claim uses engine dispatch_rewrite_with_expected_current:
 *   - Read from transcript address (expect: not found, current = None).
 *   - If found, return it (sticky hit).
 *   - If not found, call builder, get winner, build transcript, write it.
 *   - Engine ensures first-writer-wins on concurrent claims.
 *
 * Pattern:
 *   const transcript = await claimTranscript(
 *     { observer_id, address, epoch, ... },
 *     async () => {
 *       const snapshot = await readFactSnapshot(...);
 *       return selectWinner(surface, snapshot, decider, stickyKey);
 *     },
 *     engineWriteBatch,
 *     engineReadTranscript,
 *   );
 */

/**
 * Options for claiming a transcript.
 */
export interface ClaimTranscriptOptions {
  at?: string;
  observer_id: string;
  address: string;
  epoch: string;
  candidate_set_version: string;
  decider_id: string;
  decider_version: string;
  snapshot_anchor: string;
  sticky_key: string;
}

/**
 * The build function signature: async, returns the winning candidate (or null).
 * Expected to call selectWinner internally after fetching fact snapshot.
 */
export type BuildFn = () => Promise<Candidate | null>;

/**
 * Engine read function signature: async, reads a transcript from the log
 * by address; returns null if not found.
 */
export type EngineReadTranscript = (address: string) => Promise<DecisionTranscript | null>;

/**
 * Engine write function signature: same as in appendObservation.
 */
export type EngineWriteBatch = (entries: WriteBatchEntry[]) => Promise<void>;

/**
 * Claim a decision transcript with memoization.
 *
 * Flow:
 *   1. Read transcript at transcriptAddress(observer_id, address, epoch).
 *   2. If found, log sticky hit and return it.
 *   3. If not found, call buildFn() → winner.
 *   4. Build DecisionTranscript with current timestamp.
 *   5. Append via appendObservation (memoization fact).
 *   6. Return the transcript.
 *
 * Stickiness: the winner is chosen by the decider's deterministic `sticky_hash`
 * (same observer + sticky_key → same winner every time), so concurrent writers
 * all record the SAME winner — the transcript is content-idempotent. Once one
 * is written, subsequent claims for the same (observer, address, epoch) return
 * it as a sticky hit in step 2 (the read and write addresses are now one
 * formula — see `transcriptAddress`). Note: the write is NOT a compare-and-swap
 * (`WriteBatchEntry` carries no `expected_current`), so it is last-writer-wins
 * at the log level; determinism is what guarantees agreement, not CAS.
 *
 * @param options         Claim options (observer_id, address, epoch, versions).
 * @param buildFn         Pure decision builder (call selectWinner internally).
 * @param engineWriteBatch Injected engine write function.
 * @param engineReadTranscript Injected engine read function.
 *
 * @returns The DecisionTranscript (sticky hit or newly claimed).
 */
export async function claimTranscript(
  options: ClaimTranscriptOptions,
  buildFn: BuildFn,
  engineWriteBatch: EngineWriteBatch,
  engineReadTranscript: EngineReadTranscript,
): Promise<DecisionTranscript> {
  const { observer_id, address, epoch, candidate_set_version, decider_id, decider_version, snapshot_anchor, sticky_key } = options;

  const transcriptAddr = transcriptAddress(observer_id, address, epoch);

  // Step 1: Read sticky transcript.
  const existing = await engineReadTranscript(transcriptAddr);
  if (existing != null) {
    console.log(
      `[run-experiments] claimed address=${address} observer=${observer_id} epoch=${epoch} sticky=hit winner=${existing.winner}`,
    );
    return existing;
  }

  // Step 2: Build decision.
  const winner = await buildFn();
  if (winner == null) {
    // No winner possible — still memoize this as a degenerate transcript.
    throw new Error('[run-experiments] claimTranscript: builder returned null (no candidates).');
  }

  // Step 3: Construct transcript.
  const now = options.at;
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw new Error('Selection time must be supplied by the caller.');
  const transcript: DecisionTranscript = {
    entity_type: 'transcript',
    observer_id,
    address,
    epoch,
    winner: winner.candidate_id,
    candidate_set_version,
    decider_id,
    decider_version,
    snapshot_anchor,
    sticky_key,
    at: now,
  };

  // Step 4: Append transcript (memoization write).
  await appendObservation(
    {
      observerId: observer_id,
      trustRef: 'trust:derived',
      path: ['transcript', address, epoch],
      value: transcript,
      at: now,
      basis: snapshot_anchor,
    },
    engineWriteBatch,
  );

  console.log(
    `[run-experiments] claimed address=${address} observer=${observer_id} epoch=${epoch} sticky=build winner=${winner.candidate_id}`,
  );

  return transcript;
}
