// tools/run-experiments/read-data/scoreboard.ts
//
// Purpose: Aggregate observer facts at an address to produce per-candidate outcomes.
// Scoreboard is the read-side projection: given all observation facts at an address,
// count per-candidate metrics (views, clicks, conversions, etc.).
//
// O(facts at address) — no full scan. Typed index, not JSON.
//
// Non-negotiable invariants:
//   1. Aggregation is READ-ONLY (no mutations to source facts).
//   2. Index outcome facts by candidate_id → {metric → value}.
//   3. Unknown candidates are skipped (no auto-expansion).
//   4. Absent metric → undefined (caller interprets as 0/cold-start).
//   5. No side effects — pure projection.

import type { ObserverFact } from './score-candidates.ts';

// ---------------------------------------------------------------------------
// Scoreboard data structures
// ---------------------------------------------------------------------------

/**
 * Aggregated outcome metrics for one candidate at an address.
 *
 * `views`     — number of times this candidate was observed/evaluated.
 * `clicks`    — number of times clicked/selected.
 * `converted` — number of conversion events.
 * `rate`      — conversion rate ([0, 1], computed as converted / views or raw metric).
 * `[metric]`  — any custom outcome metric (string → number).
 */
export interface CandidateOutcomes {
  candidate_id: string;
  views?: number;
  clicks?: number;
  converted?: number;
  rate?: number;
  [metric: string]: string | number | undefined;
}

/**
 * Scoreboard: aggregated outcomes for all candidates at an address.
 *
 * `address`      — the selection-surface address (e.g. checkout.payment_method).
 * `candidates`   — map of candidate_id → aggregated outcomes.
 * `total_events` — total outcome facts processed.
 * `as_timestamp` — ISO 8601 UTC when this scoreboard was computed.
 */
export interface Scoreboard {
  address: string;
  candidates: Record<string, CandidateOutcomes>;
  total_events: number;
  as_timestamp: string;
}

// ---------------------------------------------------------------------------
// aggregateOutcomes — pure projection
// ---------------------------------------------------------------------------

/**
 * Aggregate observer facts at an address to produce per-candidate outcomes.
 *
 * Scans fact paths of shape ["candidate", "outcome", metric, candidate_id].
 * Groups by candidate_id and metric, sums counts.
 *
 * Pattern:
 *   facts at address = [
 *     {path: ["candidate","outcome","views","a"], value: 10},
 *     {path: ["candidate","outcome","clicks","a"], value: 2},
 *     {path: ["candidate","outcome","views","b"], value: 8},
 *     {path: ["candidate","outcome","rate","b"], value: 0.25},
 *   ]
 *   Result:
 *   {
 *     "a": {candidate_id:"a", views:10, clicks:2},
 *     "b": {candidate_id:"b", views:8, rate:0.25},
 *   }
 *
 * @param address      The selection-surface address (for the scoreboard record).
 * @param facts        All observation facts (caller should filter to address).
 * @returns            Scoreboard with aggregated outcomes.
 */
export function aggregateOutcomes(address: string, facts: ObserverFact[]): Scoreboard {
  const candidates: Record<string, CandidateOutcomes> = {};
  let totalEvents = 0;

  for (const fact of facts) {
    const path = fact.path;

    // Match paths of shape ["candidate", "outcome", metric, candidate_id]
    if (path.length !== 4 || path[0] !== 'candidate' || path[1] !== 'outcome') {
      continue;
    }

    const metric = path[2];
    const candidateId = path[3];

    if (typeof metric !== 'string' || typeof candidateId !== 'string') {
      continue;
    }

    // Ensure candidate entry exists.
    if (!(candidateId in candidates)) {
      candidates[candidateId] = { candidate_id: candidateId };
    }

    const candidate = candidates[candidateId];

    // Accumulate the metric. Handle numeric values (sum) and other types (last-write).
    const value = fact.value;
    if (typeof value === 'number') {
      const current = candidate[metric];
      if (typeof current === 'number') {
        candidate[metric] = current + value;
      } else {
        candidate[metric] = value;
      }
    } else {
      // Non-numeric: store as-is (last-write-wins).
      candidate[metric] = value;
    }

    totalEvents++;
  }

  const now = new Date().toISOString();
  console.log(
    `[run-experiments] aggregateOutcomes address=${address} candidates=${Object.keys(candidates).length} total_events=${totalEvents}`,
  );

  return {
    address,
    candidates,
    total_events: totalEvents,
    as_timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// readOutcome — typed lookup
// ---------------------------------------------------------------------------

/**
 * Read a single outcome metric for a candidate from a scoreboard.
 * Returns undefined if the candidate or metric is absent.
 *
 * @param scoreboard   The aggregated scoreboard.
 * @param candidateId  The candidate to look up.
 * @param metric       The metric name (e.g. "rate", "views").
 * @returns            The metric value, or undefined if absent.
 */
export function readOutcome(
  scoreboard: Scoreboard,
  candidateId: string,
  metric: string,
): number | undefined {
  const candidate = scoreboard.candidates[candidateId];
  if (candidate == null) return undefined;
  const value = candidate[metric];
  if (typeof value === 'number') return value;
  return undefined;
}

/**
 * Compute a derived metric (e.g. rate = converted / views) from raw outcomes.
 *
 * @param scoreboard   The aggregated scoreboard.
 * @param candidateId  The candidate to look up.
 * @param numerator    Metric name for the numerator (e.g. "converted").
 * @param denominator  Metric name for the denominator (e.g. "views").
 * @returns            The computed rate, or undefined if either metric is absent.
 */
export function computeRate(
  scoreboard: Scoreboard,
  candidateId: string,
  numerator: string,
  denominator: string,
): number | undefined {
  const num = readOutcome(scoreboard, candidateId, numerator);
  const denom = readOutcome(scoreboard, candidateId, denominator);
  if (num == null || denom == null || denom === 0) return undefined;
  return num / denom;
}
