import {
  readProcessSessionEventHead,
  readProcessSessionEventsFeed,
  type ProcessSessionEventsFeedView,
  type ProcessSessionOutputStream,
  type ProcessSessionState,
} from './read-process-session-events.ts';
import type { ProcessSessionSnapshot } from './read-process-sessions.ts';

const SUMMARY_LIMIT = 140;
const textDecoder = new TextDecoder();

export interface AddressedProcessSessionEventFeed {
  address: string;
  data: Uint8Array | ProcessSessionEventsFeedView;
}

export interface ProcessSessionActivityEvent {
  sessionId: string;
  timestamp: string;
  hookType: string;
  toolName: string | null;
  summary: string;
  agentName: string | null;
  model: string | null;
  account: string | null;
  cwd: string | null;
}

function isoFromMs(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function sessionFallbackTimestamp(session: ProcessSessionSnapshot): string {
  return isoFromMs(session.started_at_ms)
    ?? isoFromMs(session.updated_at_ms)
    ?? new Date(0).toISOString();
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= SUMMARY_LIMIT) return normalized;
  return `${normalized.slice(0, SUMMARY_LIMIT - 3)}...`;
}

function summarizeOutputBytes(stream: ProcessSessionOutputStream, bytes: Uint8Array): string {
  const text = boundedSummary(textDecoder.decode(bytes));
  if (text.length > 0) return text;
  return `${stream} ${bytes.byteLength} byte${bytes.byteLength === 1 ? '' : 's'}`;
}

function stateSummary(state: ProcessSessionState, exitCode: number | null, failureReason: string | null): string {
  if (state === 'exited') {
    return exitCode == null ? 'Session exited' : `Session exited with code ${exitCode}`;
  }
  if (state === 'failed') {
    return failureReason ? `Session failed: ${boundedSummary(failureReason)}` : 'Session failed';
  }
  return 'Session running';
}

function asFeedView(data: Uint8Array | ProcessSessionEventsFeedView): ProcessSessionEventsFeedView {
  if (data instanceof Uint8Array) return readProcessSessionEventsFeed(data);
  return data;
}

function append(
  map: Map<string, ProcessSessionActivityEvent[]>,
  event: ProcessSessionActivityEvent,
): void {
  const events = map.get(event.sessionId) ?? [];
  events.push(event);
  map.set(event.sessionId, events);
}

/**
 * Discover the V2 per-event delta-stream addresses named by HEAD payloads in
 * the given feeds, mapped back to the owning feed address. Consumers subscribe
 * these addresses alongside the feeds and pass BOTH payload sets to
 * `buildProcessSessionActivityMap` — a delta stream's events attribute to the
 * same session as its head's feed address. V1 payloads carry events inline
 * and contribute nothing here.
 */
export function discoverProcessSessionEventStreams(
  eventFeeds: readonly AddressedProcessSessionEventFeed[],
): Map<string, string> {
  const feedAddressByStreamAddress = new Map<string, string>();
  for (const feed of eventFeeds) {
    if (!(feed.data instanceof Uint8Array)) continue;
    try {
      const head = readProcessSessionEventHead(feed.data);
      if (head?.eventStreamAddress) {
        feedAddressByStreamAddress.set(head.eventStreamAddress, feed.address);
      }
    } catch {
      // Not a head payload — V1 feed, nothing to discover.
    }
  }
  return feedAddressByStreamAddress;
}

export function buildProcessSessionActivityMap(
  sessions: readonly ProcessSessionSnapshot[],
  eventFeeds: readonly AddressedProcessSessionEventFeed[],
  eventStreams: readonly AddressedProcessSessionEventFeed[] = [],
): Record<string, ProcessSessionActivityEvent[]> {
  const eventsBySession = new Map<string, ProcessSessionActivityEvent[]>();
  const sessionByEventAddress = new Map<string, ProcessSessionSnapshot>();

  // V2: delta-stream payloads attribute to the session that owns the head
  // whose event_stream_address named them.
  const feedAddressByStreamAddress = discoverProcessSessionEventStreams(eventFeeds);
  const attributedStreams: AddressedProcessSessionEventFeed[] = [];
  for (const stream of eventStreams) {
    const feedAddress = feedAddressByStreamAddress.get(stream.address);
    if (feedAddress) attributedStreams.push({ address: feedAddress, data: stream.data });
  }
  const allFeeds = attributedStreams.length > 0 ? [...eventFeeds, ...attributedStreams] : eventFeeds;

  for (const session of sessions) {
    if (session.event_feed_address) sessionByEventAddress.set(session.event_feed_address, session);
    const timestamp = isoFromMs(session.started_at_ms);
    if (!timestamp) continue;
    append(eventsBySession, {
      sessionId: session.session_id,
      timestamp,
      hookType: 'SessionStart',
      toolName: 'SessionStart',
      summary: 'Session started',
      agentName: null,
      model: null,
      account: null,
      cwd: session.cwd,
    });
  }

  for (const feed of allFeeds) {
    const session = sessionByEventAddress.get(feed.address);
    if (!session) continue;

    try {
      asFeedView(feed.data).forEachEvent({
        onOutputBytes: (sessionId, _eventNumber, recordedAtMs, stream, bytes) => {
          append(eventsBySession, {
            sessionId,
            timestamp: isoFromMs(recordedAtMs) ?? sessionFallbackTimestamp(session),
            hookType: 'OutputBytes',
            toolName: stream,
            summary: summarizeOutputBytes(stream, bytes),
            agentName: null,
            model: null,
            account: null,
            cwd: session.cwd,
          });
        },
        onSessionStateChanged: (sessionId, _eventNumber, recordedAtMs, state, exitCode, failureReason) => {
          append(eventsBySession, {
            sessionId,
            timestamp: isoFromMs(recordedAtMs) ?? sessionFallbackTimestamp(session),
            hookType: 'SessionStateChanged',
            toolName: state,
            summary: stateSummary(state, exitCode, failureReason),
            agentName: null,
            model: null,
            account: null,
            cwd: session.cwd,
          });
        },
        onCommandRejected: (sessionId, _eventNumber, recordedAtMs, reason) => {
          append(eventsBySession, {
            sessionId,
            timestamp: isoFromMs(recordedAtMs) ?? sessionFallbackTimestamp(session),
            hookType: 'CommandRejected',
            toolName: 'command-rejected',
            summary: boundedSummary(reason),
            agentName: null,
            model: null,
            account: null,
            cwd: session.cwd,
          });
        },
      });
    } catch (error) {
      append(eventsBySession, {
        sessionId: session.session_id,
        timestamp: sessionFallbackTimestamp(session),
        hookType: 'ProcessSessionFeedError',
        toolName: 'process-session-events',
        summary: error instanceof Error ? boundedSummary(error.message) : 'Invalid process-session event feed',
        agentName: null,
        model: null,
        account: null,
        cwd: session.cwd,
      });
    }
  }

  return Object.fromEntries(
    [...eventsBySession.entries()].map(([sessionId, events]) => [
      sessionId,
      events.sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    ]),
  );
}
