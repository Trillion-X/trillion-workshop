// packages/background-runner-control/read-data/read-background-runner-status.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure background runner status projected-row decoding.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Decoder consumes only projected rows supplied by the package data hook
// 2. Canonical ownership remains outside this pure decoder
// 3. No connection access or write-shape construction
//
// =============================================================================

export interface BackgroundRunnerStatusRecord {
  running: boolean;
  maxConcurrentExecutions: number;
  queueDepth: number;
  executingTasks: string[];
  loopsCompleted: number;
  tasksExecuted: number;
}

function coerceBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function coerceNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function decodeBackgroundRunnerStatusFeed(raw: unknown): BackgroundRunnerStatusRecord {
  const row = Array.isArray(raw)
    ? raw.find((entry): entry is Record<string, unknown> => (
        !!entry && typeof entry === 'object' && !Array.isArray(entry)
      ))
    : null;

  if (!row) {
    return {
      running: false,
      maxConcurrentExecutions: 1,
      queueDepth: 0,
      executingTasks: [],
      loopsCompleted: 0,
      tasksExecuted: 0,
    };
  }

  return {
    running: coerceBoolean(row.running),
    maxConcurrentExecutions: coerceNumber(row.maxConcurrentExecutions, 1),
    queueDepth: coerceNumber(row.queueDepth, 0),
    executingTasks: Array.isArray(row.executingTasks)
      ? row.executingTasks.filter((entry): entry is string => typeof entry === 'string')
      : [],
    loopsCompleted: coerceNumber(row.loopsCompleted, 0),
    tasksExecuted: coerceNumber(row.tasksExecuted, 0),
  };
}
