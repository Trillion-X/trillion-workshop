export type ProcessSessionState = 'running' | 'exited' | 'failed';

export interface ProcessSessionTextGrid {
  columns: number;
  rows: number;
}

export interface ProcessSessionSettings {
  text_grid: ProcessSessionTextGrid | null;
}

export interface ProcessSessionSnapshot {
  session_id: string;
  event_feed_address: string;
  state: ProcessSessionState;
  argv: string[];
  cwd: string | null;
  session_settings: ProcessSessionSettings;
  started_at_ms: number;
  updated_at_ms: number;
  command_count: number;
  event_count: number;
  exit_code: number | null;
  failure_reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asState(value: unknown): ProcessSessionState {
  return value === 'exited' || value === 'failed' ? value : 'running';
}

function decodeSettings(raw: unknown): ProcessSessionSettings {
  if (!isRecord(raw)) {
    return { text_grid: null };
  }

  const textGrid = raw.text_grid;
  if (!isRecord(textGrid)) {
    return { text_grid: null };
  }

  return {
    text_grid: {
      columns: asNumber(textGrid.columns),
      rows: asNumber(textGrid.rows),
    },
  };
}

export function decodeProcessSessionSnapshot(raw: unknown): ProcessSessionSnapshot | null {
  if (!isRecord(raw)) return null;

  const sessionId = asString(raw.session_id);
  if (!sessionId) return null;

  return {
    session_id: sessionId,
    event_feed_address: asString(raw.event_feed_address) ?? '',
    state: asState(raw.state),
    argv: Array.isArray(raw.argv)
      ? raw.argv.filter((value): value is string => typeof value === 'string')
      : [],
    cwd: asString(raw.cwd),
    session_settings: decodeSettings(raw.session_settings),
    started_at_ms: asNumber(raw.started_at_ms),
    updated_at_ms: asNumber(raw.updated_at_ms),
    command_count: asNumber(raw.command_count),
    event_count: asNumber(raw.event_count),
    exit_code: asNullableNumber(raw.exit_code),
    failure_reason: asString(raw.failure_reason),
  };
}

export function decodeProcessSessionsFeed(raw: unknown): ProcessSessionSnapshot[] {
  const sessions = Array.isArray(raw) ? raw : [];
  return sessions
    .map((session) => decodeProcessSessionSnapshot(session))
    .filter((session): session is ProcessSessionSnapshot => session !== null)
    .sort((left, right) => {
      const byStartedAt = left.started_at_ms - right.started_at_ms;
      return byStartedAt !== 0 ? byStartedAt : left.session_id.localeCompare(right.session_id);
    });
}
