// bitfield/packages/away-summary/read-data/read-away-summary.ts
//
// Away-summary-owned projected payload decoding.

export interface AwaySummaryData {
  tasksCompleted: AwaySummaryTaskReceipt[];
  totalCost: number;
  totalTimeMinutes: number;
  errors: number;
  commits: string[];
  sessionCount: number;
  periodStartMs: number;
  periodEndMs: number;
}

export interface AwaySummaryTaskReceipt {
  taskId?: string;
  taskName?: string;
  summary?: string;
  cost?: number;
  testsWritten?: number;
  [key: string]: unknown;
}

interface AwaySummaryRow {
  since?: unknown;
  summary?: unknown;
  items?: unknown;
  createdAt?: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asTaskReceipts(value: unknown): AwaySummaryTaskReceipt[] {
  return Array.isArray(value)
    ? value.filter((item): item is AwaySummaryTaskReceipt => !!item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coerceNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseMs(value: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function decodeAwaySummaryFeed(raw: unknown): AwaySummaryData[] {
  const rows = Array.isArray(raw) ? raw : [];
  const summaries: AwaySummaryData[] = [];

  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as AwaySummaryRow;
    const summary = asObject(row.summary);
    const periodStartMs = parseMs(asString(row.since));
    const periodEndMs = parseMs(asString(row.createdAt)) || periodStartMs;
    if (periodStartMs <= 0 || periodEndMs < periodStartMs) continue;

    summaries.push({
      tasksCompleted: asTaskReceipts(row.items),
      totalCost: coerceNumber(summary.totalCost),
      totalTimeMinutes: coerceNumber(summary.totalTimeMinutes),
      errors: coerceNumber(summary.errors),
      commits: coerceStringArray(summary.commits),
      sessionCount: coerceNumber(summary.sessionCount),
      periodStartMs,
      periodEndMs,
    });
  }

  return summaries;
}
