// packages/group/read-data/write-count.ts
//
// THE ONE parser for an `engine.operation.write-batch` reply → the number of records written.
// The live write front door returns the write-count as 8 RAW BYTES (u64 little-endian), but test
// senders and some transports return it as a number/object/JSON string — so this reader accepts
// every shape and yields the count (L063: written once, not re-derived per writer). Extracted from
// `write-appearance-preset-live.ts` when a 2nd (focus-view) and the existing action-affordance
// writer would otherwise triplicate it. Pure, never throws.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The number of records an `engine.operation.write-batch` reply reports as written (0 on any
 *  unrecognized shape). Accepts: an object with `write_count`/`writeCount` (or nested `payload`),
 *  an 8-byte u64-LE buffer/typed-array, or a JSON/number string. */
export function writeCountOf(reply: unknown): number {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    const r = reply as Record<string, unknown>;
    if ('write_count' in r || 'writeCount' in r) {
      const raw = r.write_count ?? r.writeCount;
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    }
    if (r.payload !== undefined) return writeCountOf(r.payload);
  }
  let bytes: Uint8Array | null = null;
  if (reply instanceof Uint8Array) bytes = reply;
  else if (reply instanceof ArrayBuffer) bytes = new Uint8Array(reply);
  else if (ArrayBuffer.isView(reply)) bytes = new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  else if (typeof reply === 'string') bytes = textEncoder.encode(reply);
  if (!bytes) return 0;
  if (bytes.byteLength === 8) {
    let value = 0;
    for (let shift = 7; shift >= 0; shift -= 1) value = value * 256 + bytes[shift]!;
    return Number.isSafeInteger(value) ? value : 0;
  }
  const text = textDecoder.decode(bytes).trim();
  if (!text) return 0;
  try {
    return writeCountOf(JSON.parse(text) as unknown);
  } catch {
    return 0;
  }
}
