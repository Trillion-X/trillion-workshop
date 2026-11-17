// packages/choose-per-observer/read-data/scoreboard-projection.ts
//
// The LIVE experiment scoreboard as a PROJECTION (no persisted derived facts —
// SSOT). Given the selection-surface, the assignment records (decision
// transcripts), the raw conversion/outcome facts, and the attribution-join
// config, this composes the two already-tested pure reducers end to end:
//
//   attributeOutcomes(join, assignments, outcomes) → per-candidate observation
//     facts  (path ['candidate','outcome', metric, candidate_id])
//   aggregateOutcomes(address, thoseFacts)          → per-candidate metric totals
//   buildScoreboardViewModel({surface, metrics, …}) → the blind ScoreboardSurface
//
// The scoreboard is a derived VIEW over the primary assignment + conversion
// facts — it is never stored, so there is no second source of truth to drift.
// Pure: the caller (mount) does the I/O and passes the records in.

import type { SelectionSurface } from '../../../../funnels-screen/read-data/candidate-set-schema';
import { attributeOutcomes, type AttributionJoin } from './attribute-outcomes';
import { aggregateOutcomes } from './scoreboard';
import type { ObserverFact } from './score-candidates';
import {
  buildScoreboardViewModel,
  type ScoreboardViewModel,
  type SignificanceSignal,
  type OutcomeMetricsByCandidate,
} from '../show/scoreboard-view-model';

export interface ScoreboardProjectionInput {
  surface: SelectionSurface;
  join: AttributionJoin;
  assignments: readonly unknown[];
  outcomes: readonly unknown[];
  /** Owner significance signal. When omitted, a leader is inferred (leading, not
   *  decided) from the leader metric so the board can highlight a front-runner
   *  without ever declaring a winner (L117 — no fake winner). */
  significance?: SignificanceSignal;
  /** Which emitted metric decides the front-runner when inferring significance
   *  (default 'conversions'). DATA — the projection names no metric itself. */
  leaderMetric?: string;
  now: string;
}

export interface ScoreboardProjection {
  viewModel: ScoreboardViewModel;
  metrics: OutcomeMetricsByCandidate;
  findings: string[];
}

/** Strip the reserved `candidate_id` key and keep only numeric metric totals. */
function metricsOnly(candidate: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === 'candidate_id') continue;
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/** Front-runner = the candidate with the greatest `leaderMetric` total. Returns
 *  null on a tie or when no candidate has any of that metric (→ "collecting"). */
function inferLeaderId(metrics: OutcomeMetricsByCandidate, leaderMetric: string): string | null {
  let leaderId: string | null = null;
  let best = -Infinity;
  let tie = false;
  for (const [candidateId, m] of Object.entries(metrics)) {
    const v = m[leaderMetric] ?? 0;
    if (v > best) { best = v; leaderId = candidateId; tie = false; }
    else if (v === best) { tie = true; }
  }
  if (best <= 0 || tie) return null;
  return leaderId;
}

/** Compose the live scoreboard view-model from primary assignment + conversion
 *  facts. Pure — no I/O, no persistence. */
export function projectScoreboard(input: ScoreboardProjectionInput): ScoreboardProjection {
  const leaderMetric = input.leaderMetric ?? 'conversions';
  const { observations, findings } = attributeOutcomes(input.join, input.assignments, input.outcomes, input.now);

  // Feed the attributed observations to the read-side aggregator as facts.
  const facts: ObserverFact[] = observations.map((o) => ({
    path: o.path,
    trust_ref: o.trustRef,
    value: o.value,
  }));
  const scoreboard = aggregateOutcomes(input.surface.address, facts);

  const metrics: Record<string, Record<string, number>> = {};
  for (const [candidateId, candidate] of Object.entries(scoreboard.candidates)) {
    metrics[candidateId] = metricsOnly(candidate as Record<string, unknown>);
  }

  const significance: SignificanceSignal =
    input.significance ?? { decided: false, leaderId: inferLeaderId(metrics, leaderMetric) };

  const viewModel = buildScoreboardViewModel({ surface: input.surface, metrics, significance });
  return { viewModel, metrics, findings };
}
