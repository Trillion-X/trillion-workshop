import type { MeetingCaptureStartEvent } from '../read-data/capture-policy';

/** A live host observation, not an editable calendar association or restored screen input. */
export type MeetingApplicationRecordingInvocation = MeetingCaptureStartEvent & {
  kind: 'application-input-started';
  throughApp: false;
  appId: string;
  appName: string;
  processId: number;
  nativeDocumentId: string;
  nativeSessionId: string;
  nativeEpisodeId: string;
  invocationId: string;
  initiatedAt: string;
  expiresAt: string;
  runtimeSessionId: string;
};

let heldRuntimeSessionId: string | null = null;
/** This session's id, made on first use: a Worker refuses randomness while its modules load. */
const runtimeSessionId = () => (heldRuntimeSessionId ??= crypto.randomUUID());
const maxAgeMs = 2 * 60 * 1000;
const issued = new Map<string, { value: MeetingApplicationRecordingInvocation; current: () => boolean }>();

/** Retained source evidence. This metadata cannot initiate or resume capture. */
export type MeetingApplicationInputContext = Pick<MeetingApplicationRecordingInvocation,
  'appId' | 'appName' | 'nativeEpisodeId' | 'invocationId' | 'initiatedAt'>;

export function readMeetingApplicationInputContext(value: unknown): MeetingApplicationInputContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as MeetingApplicationInputContext;
  if (![row.appId, row.appName, row.nativeEpisodeId, row.invocationId].every(item => typeof item === 'string'
    && item.trim() === item && item.length > 0 && item.length <= 512 && !/[\u0000-\u001f\u007f]/.test(item))
    || row.invocationId !== `native-input:${row.nativeEpisodeId}` || typeof row.initiatedAt !== 'string'
    || !Number.isFinite(Date.parse(row.initiatedAt))) return null;
  return { appId: row.appId, appName: row.appName, nativeEpisodeId: row.nativeEpisodeId,
    invocationId: row.invocationId, initiatedAt: row.initiatedAt };
}

export function createMeetingApplicationRecordingInvocation(
  source: Pick<MeetingApplicationRecordingInvocation, 'appId' | 'appName' | 'processId' | 'nativeDocumentId' | 'nativeSessionId' | 'nativeEpisodeId'>,
  current: () => boolean,
  now = Date.now(),
): MeetingApplicationRecordingInvocation {
  if (![source.appId, source.appName, source.nativeDocumentId, source.nativeSessionId, source.nativeEpisodeId].every(value => typeof value === 'string' && value.trim())
    || !Number.isSafeInteger(source.processId) || source.processId <= 0 || typeof current !== 'function' || !current())
    throw new TypeError('A current native application input observation is required.');
  for (const [id, held] of issued) if (Date.parse(held.value.expiresAt) <= now || !held.current()) issued.delete(id);
  const value: MeetingApplicationRecordingInvocation = Object.freeze({
    ...source, kind: 'application-input-started', throughApp: false,
    // The native episode is shared across WK windows. The existing IndexedDB
    // claim consumes that episode once even when two documents observe it.
    invocationId: `native-input:${source.nativeEpisodeId}`, initiatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + maxAgeMs).toISOString(), runtimeSessionId: runtimeSessionId(),
  });
  issued.set(value.invocationId, { value, current });
  return value;
}

/** Recheck the actual host observation after permission/storage waits and on reminder clicks. */
export function isCurrentMeetingApplicationRecordingInvocation(
  value: unknown, now = Date.now(),
): value is MeetingApplicationRecordingInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as MeetingApplicationRecordingInvocation;
  const held = issued.get(candidate.invocationId);
  if (!held || candidate.runtimeSessionId !== runtimeSessionId()) return false;
  if (Object.keys(candidate).length !== Object.keys(held.value).length
    || Object.keys(held.value).some(key => candidate[key as keyof typeof candidate] !== held.value[key as keyof typeof held.value])) return false;
  const start = Date.parse(candidate.initiatedAt), end = Date.parse(candidate.expiresAt);
  return Number.isFinite(start) && start <= now && Number.isFinite(end) && end > now && end - start === maxAgeMs && held.current();
}
