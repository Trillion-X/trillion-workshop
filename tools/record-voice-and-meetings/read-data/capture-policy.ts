export const RECORD_AUDIO_CAPTURE_POLICY_INPUT = 'recordAudioCapturePolicy';

export type MeetingCaptureStartMode = 'automatic' | 'through-app' | 'reminder' | 'manual';

export type MeetingCaptureStartPolicy = {
  mode: MeetingCaptureStartMode;
  /** Stable host application identifiers. Empty means the mode applies to every matching meeting event. */
  allowedApps: string[];
  blockedApps: string[];
};

export type MeetingCaptureStartEvent = {
  kind: 'meeting-join-initiated' | 'application-input-started';
  /** True only when this application initiated the external meeting link. */
  throughApp: boolean;
  /** Host-provided stable application identity, when the event has one. */
  appId?: string | null;
};

export type MeetingCaptureStartDecision = 'start' | 'remind' | 'manual' | 'ignore';

export type RecordAudioCapturePolicy = {
  journalLeaseMs: number;
  journalHeartbeatMs: number;
};

const MEETING_START_MODES: MeetingCaptureStartMode[] = ['automatic', 'through-app', 'reminder', 'manual'];
const MAX_POLICY_APP_IDS = 128;
const MAX_POLICY_APP_ID_LENGTH = 256;

function isStableAppId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_POLICY_APP_ID_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function decodeAppIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_POLICY_APP_IDS || !value.every(isStableAppId)) return null;
  return [...new Set(value)];
}

function positiveNumber(record: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

export function decodeRecordAudioCapturePolicy(value: unknown): RecordAudioCapturePolicy {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const journalLeaseMs = positiveNumber(record, ['journal_lease_ms', 'journalLeaseMs'], 5_000);
  const requestedHeartbeatMs = positiveNumber(record, ['journal_heartbeat_ms', 'journalHeartbeatMs'], 1_000);
  return {
    journalLeaseMs,
    journalHeartbeatMs: Math.min(requestedHeartbeatMs, Math.max(1, Math.floor(journalLeaseMs / 2))),
  };
}

/** Reads the shared meeting-start policy from capture-policy DATA; absent policy stays manual. */
export function decodeMeetingCaptureStartPolicy(value: unknown): MeetingCaptureStartPolicy {
  // Older saved preferences stored the mode as a scalar string.
  if (typeof value === 'string') {
    return {
      mode: MEETING_START_MODES.includes(value as MeetingCaptureStartMode)
        ? value as MeetingCaptureStartMode
        : 'manual',
      allowedApps: [],
      blockedApps: [],
    };
  }
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const start = record.meeting_start && typeof record.meeting_start === 'object' && !Array.isArray(record.meeting_start)
    ? record.meeting_start as Record<string, unknown>
    : {};
  const mode = MEETING_START_MODES.includes(start.mode as MeetingCaptureStartMode)
    ? start.mode as MeetingCaptureStartMode
    : 'manual';
  const allowedApps = decodeAppIds(start.allowed_apps);
  const blockedApps = decodeAppIds(start.blocked_apps);
  // A malformed selector must never turn a requested automatic policy into a broader one.
  const safeMode = allowedApps && blockedApps ? mode : 'manual';
  return {
    mode: safeMode,
    allowedApps: allowedApps ?? [],
    blockedApps: blockedApps ?? [],
  };
}

/** Decide whether a meeting-join request may start capture under the saved policy. */
export function decideMeetingCaptureStart(
  policy: MeetingCaptureStartPolicy,
  event: MeetingCaptureStartEvent,
): MeetingCaptureStartDecision {
  if (!event || !['meeting-join-initiated', 'application-input-started'].includes(event.kind)
    || typeof event.throughApp !== 'boolean'
    || (event.kind === 'application-input-started' && (event.throughApp || !event.appId))) return 'manual';
  if (!policy || !MEETING_START_MODES.includes(policy.mode)
    || !Array.isArray(policy.allowedApps) || !policy.allowedApps.every(isStableAppId)
    || policy.allowedApps.length > MAX_POLICY_APP_IDS
    || !Array.isArray(policy.blockedApps) || !policy.blockedApps.every(isStableAppId)
    || policy.blockedApps.length > MAX_POLICY_APP_IDS) return 'manual';
  if (event.appId != null && !isStableAppId(event.appId)) return 'manual';
  const appId = isStableAppId(event.appId) ? event.appId : '';
  if (appId && policy.blockedApps.includes(appId)) return 'ignore';
  if (policy.allowedApps.length && (!appId || !policy.allowedApps.includes(appId))) return 'ignore';
  if (policy.mode === 'automatic') return 'start';
  if (policy.mode === 'through-app') return event.throughApp ? 'start' : 'manual';
  if (policy.mode === 'reminder') return 'remind';
  return 'manual';
}
