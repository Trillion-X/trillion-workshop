export type ProcessSessionState = 'running' | 'exited' | 'failed';
export type ProcessSessionOutputStream = 'display' | 'stdout' | 'stderr';

const FEED_VERSION = 1;
const HEAD_VERSION = 2;
const EVENT_DELTA_VERSION = 3;
const EVENT_OUTPUT_BYTES = 0;
const EVENT_SESSION_STATE_CHANGED = 1;
const EVENT_COMMAND_REJECTED = 2;
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const STATE_EXITED = 1;
const STATE_FAILED = 2;

const textDecoder = new TextDecoder();

export interface ProcessSessionEventsFeedVisitor {
  onOutputBytes?: (
    sessionId: string,
    eventNumber: number,
    recordedAtMs: number,
    stream: ProcessSessionOutputStream,
    bytes: Uint8Array,
  ) => void;
  onSessionStateChanged?: (
    sessionId: string,
    eventNumber: number,
    recordedAtMs: number,
    state: ProcessSessionState,
    exitCode: number | null,
    failureReason: string | null,
  ) => void;
  onCommandRejected?: (
    sessionId: string,
    eventNumber: number,
    recordedAtMs: number,
    reason: string,
  ) => void;
}

export interface ProcessSessionEventsFeedView {
  readonly eventCount: number;
  forEachEvent(visitor: ProcessSessionEventsFeedVisitor): void;
}

function readSafeU64(view: DataView, offset: number, field: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function decodeOutputStream(tag: number): ProcessSessionOutputStream {
  if (tag === STREAM_STDOUT) return 'stdout';
  if (tag === STREAM_STDERR) return 'stderr';
  return 'display';
}

function decodeState(tag: number): ProcessSessionState {
  if (tag === STATE_EXITED) return 'exited';
  if (tag === STATE_FAILED) return 'failed';
  return 'running';
}

class ProcessSessionEventsCursor {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
    offset = 0,
  ) {
    this.offset = offset;
  }

  position(): number {
    return this.offset;
  }

  remainingLength(): number {
    return this.bytes.byteLength - this.offset;
  }

  finish(): void {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error(
        `process-session-events feed has trailing bytes: ${this.bytes.byteLength - this.offset}`,
      );
    }
  }

  readU8(field: string): number {
    this.ensure(field, 1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readU32(field: string): number {
    this.ensure(field, 4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readI32(field: string): number {
    this.ensure(field, 4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readU64(field: string): number {
    this.ensure(field, 8);
    const value = readSafeU64(this.view, this.offset, field);
    this.offset += 8;
    return value;
  }

  readBytes(field: string): Uint8Array {
    const length = this.readU32(field);
    this.ensure(field, length);
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, start + length);
  }

  readString(field: string): string {
    return textDecoder.decode(this.readBytes(field));
  }

  readOptionalI32(field: string): number | null {
    const flag = this.readU8(field);
    if (flag === 0) return null;
    if (flag === 1) return this.readI32(field);
    throw new Error(`${field} optional flag must be 0 or 1`);
  }

  readOptionalString(field: string): string | null {
    const flag = this.readU8(field);
    if (flag === 0) return null;
    if (flag === 1) return this.readString(field);
    throw new Error(`${field} optional flag must be 0 or 1`);
  }

  private ensure(field: string, length: number): void {
    if (this.offset + length > this.bytes.byteLength) {
      throw new Error(`${field} overruns process-session-events feed at offset ${this.offset}`);
    }
  }
}

class ProcessSessionEventsView implements ProcessSessionEventsFeedView {
  readonly eventCount: number;

  private readonly sessionIds: string[] = [];
  private readonly eventsOffset: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
  ) {
    const cursor = new ProcessSessionEventsCursor(bytes, view);
    const version = cursor.readU8('version');
    if (version !== FEED_VERSION) {
      throw new Error(`unsupported process-session-events feed version ${version}`);
    }

    const sessionCount = cursor.readU32('session_id_count');
    for (let index = 0; index < sessionCount; index += 1) {
      this.sessionIds.push(cursor.readString('session_id'));
    }

    this.eventCount = cursor.readU32('event_count');
    this.eventsOffset = cursor.position();
  }

  forEachEvent(visitor: ProcessSessionEventsFeedVisitor): void {
    const cursor = new ProcessSessionEventsCursor(this.bytes, this.view, this.eventsOffset);

    for (let index = 0; index < this.eventCount; index += 1) {
      const sessionId = this.sessionIds[cursor.readU32('session_index')];
      if (!sessionId) throw new Error('process-session-events session index is out of bounds');
      const eventNumber = cursor.readU64('event_number');
      const recordedAtMs = cursor.readU64('recorded_at_ms');
      const kind = cursor.readU8('kind');

      if (kind === EVENT_OUTPUT_BYTES) {
        visitor.onOutputBytes?.(
          sessionId,
          eventNumber,
          recordedAtMs,
          decodeOutputStream(cursor.readU8('output_stream')),
          cursor.readBytes('output_bytes'),
        );
        continue;
      }

      if (kind === EVENT_SESSION_STATE_CHANGED) {
        visitor.onSessionStateChanged?.(
          sessionId,
          eventNumber,
          recordedAtMs,
          decodeState(cursor.readU8('state')),
          cursor.readOptionalI32('exit_code'),
          cursor.readOptionalString('failure_reason'),
        );
        continue;
      }

      if (kind === EVENT_COMMAND_REJECTED) {
        visitor.onCommandRejected?.(
          sessionId,
          eventNumber,
          recordedAtMs,
          cursor.readString('command_rejected.reason'),
        );
        continue;
      }

      throw new Error(`unknown process-session-events kind tag ${kind}`);
    }

    cursor.finish();
  }
}

/**
 * V2 HEAD record — the bounded projection over log-owned event history.
 * Written to the session's event-feed address once per event (constant size);
 * per-event deltas live at `eventStreamAddress`.
 */
export interface ProcessSessionEventHead {
  sessionId: string;
  eventStreamAddress: string;
  state: ProcessSessionState;
  lastEventNumber: number;
  totalEventCount: number;
  bytesWritten: number;
  outputTail: Uint8Array;
  exitCode: number | null;
  failureReason: string | null;
}

class ProcessSessionHeadView implements ProcessSessionEventsFeedView {
  readonly eventCount: number;

  constructor(readonly head: ProcessSessionEventHead) {
    // The HEAD carries no replayable events — history lives in the log at
    // head.eventStreamAddress. Feed-view consumers see an empty event list
    // plus the head, so state-only readers keep working unchanged.
    this.eventCount = 0;
  }

  forEachEvent(visitor: ProcessSessionEventsFeedVisitor): void {
    // Surface the current state transition so feed-view consumers that only
    // track session state (running/exited/failed) stay correct on V2 heads.
    if (this.head.state === 'running' && this.head.exitCode == null && !this.head.failureReason) {
      return;
    }
    visitor.onSessionStateChanged?.(
      this.head.sessionId,
      this.head.lastEventNumber,
      0,
      this.head.state,
      this.head.exitCode,
      this.head.failureReason,
    );
  }
}

function decodeHead(bytes: Uint8Array, view: DataView): ProcessSessionEventHead {
  const cursor = new ProcessSessionEventsCursor(bytes, view, 1);
  const sessionId = cursor.readString('session_id');
  const eventStreamAddress = cursor.readString('event_stream_address');
  const state = decodeState(cursor.readU8('state'));
  const lastEventNumber = cursor.readU64('last_event_number');
  const totalEventCount = cursor.readU64('total_event_count');
  const bytesWritten = cursor.readU64('bytes_written');
  const exitCode = cursor.readOptionalI32('exit_code');
  const failureReason = cursor.readOptionalString('failure_reason');
  const outputTail = cursor.remainingLength() === 0
    ? new Uint8Array()
    : cursor.readBytes('output_tail');
  cursor.finish();
  return {
    sessionId,
    eventStreamAddress,
    state,
    lastEventNumber,
    totalEventCount,
    bytesWritten,
    outputTail,
    exitCode,
    failureReason,
  };
}

export interface ProcessSessionEventDelta {
  sessionId: string;
  eventNumber: number;
  recordedAtMs: number;
}

class ProcessSessionEventDeltaView implements ProcessSessionEventsFeedView {
  readonly eventCount = 1;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
  ) {}

  forEachEvent(visitor: ProcessSessionEventsFeedVisitor): void {
    const cursor = new ProcessSessionEventsCursor(this.bytes, this.view, 1);
    const sessionId = cursor.readString('session_id');
    const eventNumber = cursor.readU64('event_number');
    const recordedAtMs = cursor.readU64('recorded_at_ms');
    const kind = cursor.readU8('kind');

    if (kind === EVENT_OUTPUT_BYTES) {
      visitor.onOutputBytes?.(
        sessionId,
        eventNumber,
        recordedAtMs,
        decodeOutputStream(cursor.readU8('output_stream')),
        cursor.readBytes('output_bytes'),
      );
    } else if (kind === EVENT_SESSION_STATE_CHANGED) {
      visitor.onSessionStateChanged?.(
        sessionId,
        eventNumber,
        recordedAtMs,
        decodeState(cursor.readU8('state')),
        cursor.readOptionalI32('exit_code'),
        cursor.readOptionalString('failure_reason'),
      );
    } else if (kind === EVENT_COMMAND_REJECTED) {
      visitor.onCommandRejected?.(
        sessionId,
        eventNumber,
        recordedAtMs,
        cursor.readString('command_rejected.reason'),
      );
    } else {
      throw new Error(`unknown process-session-events kind tag ${kind}`);
    }

    cursor.finish();
  }
}

/** Read the HEAD record from a V2 payload, or null for V1/delta payloads. */
export function readProcessSessionEventHead(bytes: Uint8Array): ProcessSessionEventHead | null {
  if (bytes.byteLength === 0 || bytes[0] !== HEAD_VERSION) return null;
  return decodeHead(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** True when the payload is a V3 single-event delta (appends to accumulated
 *  output) rather than a V1 full feed or V2 head (which replace). Consumers
 *  use this instead of inspecting version bytes — the wire format stays owned
 *  here. */
export function isProcessSessionEventDeltaPayload(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes[0] === EVENT_DELTA_VERSION;
}

/**
 * Decode any process-session events payload — the leading version byte makes
 * every payload self-identifying (V1 full feed, V2 head, V3 event delta),
 * so callers never branch on which codec applies.
 */
export function readProcessSessionEventsFeed(bytes: Uint8Array): ProcessSessionEventsFeedView {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes.byteLength > 0 ? bytes[0] : -1;
  if (version === HEAD_VERSION) {
    return new ProcessSessionHeadView(decodeHead(bytes, view));
  }
  if (version === EVENT_DELTA_VERSION) {
    return new ProcessSessionEventDeltaView(bytes, view);
  }
  return new ProcessSessionEventsView(bytes, view);
}
