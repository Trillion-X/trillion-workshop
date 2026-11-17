// bitfield/packages/away-summary/read-data/select-away-summary.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Away-summary selection logic. This module decides whether the addressed
// away-summary feed should surface a banner for a given last-seen timestamp.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure logic only — no React, no feed reads, no owner writes
// 2. Gap detection uses ISO-8601 last-seen strings and millisecond timestamps
// 3. Banner selection returns the newest summary whose period overlaps the
//    away window
//
// =============================================================================

import type { AwaySummaryData } from './read-away-summary';

export const AWAY_SUMMARY_GAP_THRESHOLD_MS = 5 * 60 * 1000;

export function calculateAwayGapMs(
  lastSeenIso: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!lastSeenIso) return 0;
  const lastSeenMs = new Date(lastSeenIso).getTime();
  if (!Number.isFinite(lastSeenMs)) return 0;
  return Math.max(0, nowMs - lastSeenMs);
}

export function selectAwaySummarySince(
  lastSeenIso: string | null | undefined,
  summaries: AwaySummaryData[],
  nowMs: number = Date.now(),
): AwaySummaryData | null {
  if (!lastSeenIso) return null;
  if (calculateAwayGapMs(lastSeenIso, nowMs) < AWAY_SUMMARY_GAP_THRESHOLD_MS) {
    return null;
  }

  const lastSeenMs = new Date(lastSeenIso).getTime();
  if (!Number.isFinite(lastSeenMs)) return null;

  return (
    summaries
      .filter(
        (summary) =>
          summary.periodStartMs >= lastSeenMs || summary.periodEndMs >= lastSeenMs,
      )
      .sort((left, right) => right.periodEndMs - left.periodEndMs)[0] ?? null
  );
}
