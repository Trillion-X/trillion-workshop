// package-set://bitfield-studio/packages/record-board-progress-feed/read-data/process-session-source-events.ts
//
// Process-session is one producer of generic source-correlated events. This
// adapter consumes process-session read-data outputs and emits this package's
// neutral event shape.

import type { ProcessSessionActivityEvent } from '@/packages/process-session/read-data/build-process-session-activity';
import type { ProcessSessionSnapshot } from '@/packages/process-session/read-data/read-process-sessions';
import type {
  ProgressDiagnostic,
  SourceCorrelatedEvent,
  SourceRecordRef,
} from './source-correlated-records';

export interface ProcessSessionSourceLink {
  sessionId: string;
  source: SourceRecordRef;
  producer?: string;
}

export interface ProcessSessionSourceEventsInput {
  sessions: readonly ProcessSessionSnapshot[];
  activityBySession: Readonly<Record<string, readonly ProcessSessionActivityEvent[]>>;
  sourceLinks: readonly ProcessSessionSourceLink[];
}

export interface ProcessSessionSourceEventsOutput {
  events: readonly SourceCorrelatedEvent[];
  diagnostics: readonly ProgressDiagnostic[];
}

const SESSION_STATE: Record<string, string> = {
  running: 'running',
  exited: 'completed',
  failed: 'failed',
};

function sourceDiagnostic(sessionId: string): ProgressDiagnostic {
  return {
    code: 'source-ref-missing',
    message: 'Process session has no configured source reference.',
    producer: 'process-session',
    eventId: `process-session:${sessionId}`,
  };
}

function sessionState(session: ProcessSessionSnapshot): string {
  return SESSION_STATE[session.state] ?? session.state;
}

function sessionTimestamp(session: ProcessSessionSnapshot): number {
  const started = Number.isFinite(session.started_at_ms) ? session.started_at_ms : 0;
  const updated = Number.isFinite(session.updated_at_ms) ? session.updated_at_ms : started;
  return updated > 0 ? updated : started;
}

function timeFromIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function processSessionSourceEvents(
  input: ProcessSessionSourceEventsInput,
): ProcessSessionSourceEventsOutput {
  const sourceBySession = new Map(input.sourceLinks.map((link) => [link.sessionId, link]));
  const events: SourceCorrelatedEvent[] = [];
  const diagnostics: ProgressDiagnostic[] = [];

  for (const session of input.sessions) {
    const link = sourceBySession.get(session.session_id);
    if (!link) {
      diagnostics.push(sourceDiagnostic(session.session_id));
      continue;
    }
    const producer = link.producer ?? 'process-session';
    events.push({
      id: `process-session:${session.session_id}:snapshot`,
      source: link.source,
      producer,
      occurredAtMs: sessionTimestamp(session),
      state: sessionState(session),
      summary: `Session ${session.state}`,
      proofRefs: session.event_feed_address
        ? [{
          id: `process-session:${session.session_id}:events`,
          label: 'Event feed',
          address: session.event_feed_address,
        }]
        : [],
      raw: session,
    });

    for (const activity of input.activityBySession[session.session_id] ?? []) {
      events.push({
        id: `process-session:${session.session_id}:activity:${activity.timestamp}:${activity.hookType}:${activity.toolName ?? ''}`,
        source: link.source,
        producer,
        occurredAtMs: timeFromIso(activity.timestamp),
        state: activity.hookType,
        summary: activity.summary,
        detail: activity.toolName ?? undefined,
        proofRefs: session.event_feed_address
          ? [{
            id: `process-session:${session.session_id}:events`,
            label: 'Event feed',
            address: session.event_feed_address,
          }]
          : [],
        raw: activity,
      });
    }
  }

  events.sort((left, right) => {
    const bySource = left.source.address.localeCompare(right.source.address);
    if (bySource !== 0) return bySource;
    const byTime = left.occurredAtMs - right.occurredAtMs;
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });

  return { events, diagnostics };
}
