// packages/choose-per-observer/show/scoreboard-view-model.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Translate the selection-surface DATA (its candidates) + per-candidate outcome
// metrics (the scoreboard aggregation, T11) + the current score result into a
// visual-database model the ScoreboardSurface renders, plus a small hero view-model
// (the leader and the win-probability) and a DATA-keyed result status per row.
//
// This is the translation boundary: the surface stays blind. Candidates become
// rows; the DATA metric descriptors become columns; each row carries a raw
// `result` status key that the status descriptor's domain maps to a tone (L090).
//
// NON-NEGOTIABLE:
//   - Cardinality is emergent. N=0 -> empty model, N=1 -> one plain row, N>=2 ->
//     experiment. ONE code path; no `if candidates.length === 1` branch.
//   - No fake winner. A winner status is only emitted when the caller's
//     significance signal says there is enough data. Otherwise rows are
//     leading/trailing/collecting — never "winner" (L117).
//   - No internal vocabulary leaks: rows are titled by the candidate's human
//     `label` (falling back to its id only as a last resort).
//
// Pure: no React, no I/O. Node-testable.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { DecodeVisualDatabaseInput } from '@/packages/visual-database/read-data/visual-database';
import type {
  Candidate,
  SelectionSurface,
} from '@/packages/choose-per-observer/read-data/candidate-set-schema';
import type { ScoreCandidatesResult } from '@/packages/choose-per-observer/read-data/score-candidates';
import {
  SCOREBOARD_METRIC_DESCRIPTORS,
  SCOREBOARD_STATUS_DESCRIPTOR,
} from '@/packages/choose-per-observer/data/scoreboard-descriptors';

/** The per-candidate outcome metrics the aggregation read (T11) produces, keyed
 *  by candidate_id. Keys match the metric descriptors' value keys (weight,
 *  views, clicks, conversions, revenue, rate). Open record — an owner adds a
 *  metric by adding a value key + a descriptor, zero change here. */
export type CandidateMetrics = Readonly<Record<string, number>>;
export type OutcomeMetricsByCandidate = Readonly<Record<string, CandidateMetrics>>;

/** The caller's significance signal — owner DATA, never inferred here. When
 *  `decided` is true a winner may be named; otherwise the surface shows
 *  "not enough data yet" and no row is a winner. `winProbability` is a 0..1
 *  ratio for the hero (the leader's probability of being best). */
export interface SignificanceSignal {
  decided: boolean;
  winProbability: number | null;
  /** The candidate_id the result favors (the leader), or null when unknown. */
  leaderId: string | null;
}

export interface ScoreboardHero {
  /** The leading version's human label, or null when there is no leader. */
  leaderLabel: string | null;
  /** 0..1 leader win probability, or null when unknown. */
  winProbability: number | null;
  /** True only when the result is statistically called (no fake winners). */
  decided: boolean;
}

export interface ScoreboardViewModel {
  /** Visual Database decode input: candidate rows + metric columns + status. */
  boardInput: DecodeVisualDatabaseInput;
  hero: ScoreboardHero;
  /** Candidate count (0..inf) — surface uses it only to choose empty/sparse
   *  COPY, never to branch the render of the board itself. */
  candidateCount: number;
}

function candidateLabel(candidate: Candidate): string {
  return (candidate.label && candidate.label.trim()) || candidate.candidate_id;
}

/** The raw result status key for a row, mapped to a tone by the status
 *  descriptor's DATA domain. NEVER returns "winner" unless the result is
 *  decided (no fake winners, L117). */
function resultStatusKey(
  candidateId: string,
  significance: SignificanceSignal,
): string {
  if (!significance.decided) return 'collecting';
  if (significance.leaderId === null) return 'collecting';
  if (candidateId === significance.leaderId) return 'winner';
  return 'trailing';
}

/** Leading (not yet decided) marking for the in-flight leader, so the hero +
 *  row read as "ahead" without claiming a winner. */
function leadingStatusKey(
  candidateId: string,
  significance: SignificanceSignal,
): string {
  if (significance.decided) return resultStatusKey(candidateId, significance);
  return candidateId === significance.leaderId ? 'leading' : 'collecting';
}

/**
 * Build the scoreboard view-model from the surface, outcome metrics, an optional
 * live score result, and the owner significance signal.
 *
 * Candidates -> rows (one record each, carrying its metrics + a result status).
 * Columns are the DATA metric descriptors + the status descriptor.
 */
export function buildScoreboardViewModel(input: {
  surface: SelectionSurface;
  metrics: OutcomeMetricsByCandidate;
  significance: SignificanceSignal;
  /** Optional live score result (drives the leader when the caller did not set
   *  one). Never required — the scoreboard works from outcome metrics alone. */
  score?: ScoreCandidatesResult | null;
}): ScoreboardViewModel {
  const { surface, metrics, score } = input;

  // Resolve the leader: prefer the explicit significance leader, else the live
  // score winner, else null. This is pure precedence over DATA — no heuristic.
  const significance: SignificanceSignal = {
    ...input.significance,
    leaderId:
      input.significance.leaderId
      ?? score?.winner?.candidate_id
      ?? null,
  };

  const records = surface.candidates.map((candidate) => {
    const m = metrics[candidate.candidate_id] ?? {};
    const status = leadingStatusKey(candidate.candidate_id, significance);
    return {
      address: `version::${surface.address}::${candidate.candidate_id}`,
      payload: {
        title: candidateLabel(candidate),
        metrics: m,
        result: status,
      },
    };
  });

  // Title descriptor reads the human label; status + metric descriptors are DATA.
  const fields = [
    {
      id: 'title',
      label: 'Version',
      role: 'title',
      paths: [['payload', 'title'], ['title']],
      editable: false,
    },
    SCOREBOARD_STATUS_DESCRIPTOR,
    ...SCOREBOARD_METRIC_DESCRIPTORS,
  ];

  const leader = significance.leaderId
    ? surface.candidates.find((c) => c.candidate_id === significance.leaderId) ?? null
    : null;

  const hero: ScoreboardHero = {
    leaderLabel: leader ? candidateLabel(leader) : null,
    winProbability: significance.winProbability,
    decided: significance.decided,
  };

  return {
    boardInput: { records, fields, views: null, actions: null },
    hero,
    candidateCount: surface.candidates.length,
  };
}
