// packages/away-summary/read-data/read-away-summary-last-seen.ts
//
// Away-summary-owned payload decoder for the last time the person saw the runtime.

export function decodeAwaySummaryLastSeen(raw: unknown): string | null {
  const rows = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];

  for (const row of rows) {
    const lastSeenAt = row.lastSeenAt;
    if (typeof lastSeenAt === 'string' && lastSeenAt.length > 0) return lastSeenAt;
  }
  return null;
}
