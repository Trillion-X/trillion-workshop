import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  readProcessSessionEventHead,
  readProcessSessionEventsFeed,
} from './read-process-session-events.ts';

// Byte-level fixtures mirror the Rust codec in
// architect/crates/execution-types/src/process_session_types.rs:
// every payload leads with a version byte (1 = full feed, 2 = head,
// 3 = event delta); strings/bytes are u32-length-prefixed little-endian.

const textEncoder = new TextEncoder();

class ByteWriter {
  private chunks: number[] = [];

  u8(value: number): this {
    this.chunks.push(value & 0xff);
    return this;
  }

  u32(value: number): this {
    for (let i = 0; i < 4; i += 1) this.chunks.push((value >>> (8 * i)) & 0xff);
    return this;
  }

  u64(value: number): this {
    let big = BigInt(value);
    for (let i = 0; i < 8; i += 1) {
      this.chunks.push(Number(big & 0xffn));
      big >>= 8n;
    }
    return this;
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  bytes(value: Uint8Array): this {
    this.u32(value.byteLength);
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  string(value: string): this {
    return this.bytes(textEncoder.encode(value));
  }

  optionalI32(value: number | null): this {
    if (value == null) return this.u8(0);
    return this.u8(1).i32(value);
  }

  optionalString(value: string | null): this {
    if (value == null) return this.u8(0);
    return this.u8(1).string(value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function encodeV2Head(overrides?: Partial<{ state: number; exitCode: number | null }>): Uint8Array {
  return new ByteWriter()
    .u8(2) // HEAD version
    .string('process_session:head-1')
    .string('1f:aa11')
    .u8(overrides?.state ?? 1) // exited
    .u64(42) // last_event_number
    .u64(42) // total_event_count
    .u64(9001) // bytes_written
    .optionalI32(overrides?.exitCode === undefined ? 0 : overrides.exitCode)
    .optionalString(null)
    .bytes(textEncoder.encode('bounded output'))
    .finish();
}

describe('readProcessSessionEventsFeed version dispatch', () => {
  it('decodes a V1 full feed unchanged', () => {
    const payload = new ByteWriter()
      .u8(1) // feed version
      .u32(1) // session count
      .string('process_session:v1')
      .u32(1) // event count
      .u32(0) // session index
      .u64(7) // event number
      .u64(1_700_000_000_000) // recorded_at_ms
      .u8(0) // OutputBytes
      .u8(1) // stdout
      .bytes(textEncoder.encode('hello'))
      .finish();

    const seen: string[] = [];
    const feed = readProcessSessionEventsFeed(payload);
    feed.forEachEvent({
      onOutputBytes: (sessionId, eventNumber, _recordedAtMs, stream, bytes) => {
        seen.push(`${sessionId}:${eventNumber}:${stream}:${new TextDecoder().decode(bytes)}`);
      },
    });

    expect(feed.eventCount).toBe(1);
    expect(seen).toEqual(['process_session:v1:7:stdout:hello']);
  });

  it('decodes a V2 head and surfaces the terminal state transition', () => {
    const payload = encodeV2Head();

    const head = readProcessSessionEventHead(payload);
    expect(head).not.toBeNull();
    expect(head?.sessionId).toBe('process_session:head-1');
    expect(head?.eventStreamAddress).toBe('1f:aa11');
    expect(head?.state).toBe('exited');
    expect(head?.lastEventNumber).toBe(42);
    expect(head?.bytesWritten).toBe(9001);
    expect(new TextDecoder().decode(head?.outputTail)).toBe('bounded output');
    expect(head?.exitCode).toBe(0);

    const transitions: Array<[string, string, number | null]> = [];
    readProcessSessionEventsFeed(payload).forEachEvent({
      onSessionStateChanged: (sessionId, _eventNumber, _recordedAtMs, state, exitCode) => {
        transitions.push([sessionId, state, exitCode]);
      },
    });
    expect(transitions).toEqual([['process_session:head-1', 'exited', 0]]);
  });

  it('emits no events for a running V2 head', () => {
    const payload = new ByteWriter()
      .u8(2)
      .string('process_session:head-2')
      .string('1f:bb22')
      .u8(0) // running
      .u64(3)
      .u64(3)
      .u64(120)
      .optionalI32(null)
      .optionalString(null)
      .finish();

    let fired = 0;
    readProcessSessionEventsFeed(payload).forEachEvent({
      onSessionStateChanged: () => {
        fired += 1;
      },
    });
    expect(fired).toBe(0);
  });

  it('decodes a V3 event delta as a single event', () => {
    const payload = new ByteWriter()
      .u8(3) // delta version
      .string('process_session:delta-1')
      .u64(11)
      .u64(1_700_000_000_500)
      .u8(0) // OutputBytes
      .u8(2) // stderr
      .bytes(textEncoder.encode('oops'))
      .finish();

    const seen: string[] = [];
    const feed = readProcessSessionEventsFeed(payload);
    feed.forEachEvent({
      onOutputBytes: (sessionId, eventNumber, _recordedAtMs, stream, bytes) => {
        seen.push(`${sessionId}:${eventNumber}:${stream}:${new TextDecoder().decode(bytes)}`);
      },
    });

    expect(feed.eventCount).toBe(1);
    expect(seen).toEqual(['process_session:delta-1:11:stderr:oops']);
  });

  it('returns null head for non-head payloads', () => {
    expect(readProcessSessionEventHead(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(readProcessSessionEventHead(new Uint8Array())).toBeNull();
  });
});
