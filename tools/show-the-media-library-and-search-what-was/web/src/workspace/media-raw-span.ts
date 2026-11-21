// src/workspace/media-raw-span.ts
//
// PURPOSE
//   The raw byte path for a recording's span: one POST of the page's door with Accept application/octet-stream, whose
//   answer is the span's bytes as the HTTP body, with X-Total-Bytes and X-Offset beside it. It is used only while
//   media-library-owner.json `raw_spans` is true; until the gateway passes a raw body through, the JSON windows
//   (media-playback.ts) carry playback. An answer that is not raw is not an error here: it answers null, and the caller
//   reads the JSON window instead.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The window is DATA (`raw_span.window_bytes`, at most `raw_span.most_bytes`); nothing here names a file or a kind.
//   2. The body is read as bytes and never decoded. Its length must match what the headers say was asked for, or the span is refused.
//   3. The fetch and the bearer come from the caller, so the reader is testable with a stand-in.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };

export type RawFetch = (path: string, init: RequestInit) => Promise<Response>;
export type RawSpan = { bytes: Uint8Array<ArrayBuffer>; total: number; offset: number };

/** One raw span of a file, or null when the answer is not a raw body (the caller falls back to the JSON window). */
export async function readRawSpan(fetcher: RawFetch, bearer: string, identity: string, offset: number, length: number): Promise<RawSpan | null> {
  const asked = Math.min(length, owner.raw_span.most_bytes);
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: owner.raw_span.door_tool, arguments: { method: owner.raw_span.method, input: { tool: owner.files_tool, call: { name: 'read_file_span', arguments: { name_or_identity: identity, raw: true, bytes: { offset, length: asked } } } } } },
  });
  const response = await fetcher(owner.raw_span.route, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/octet-stream' },
    body,
  });
  if (!response.ok) throw new Error('This recording could not be read.');
  if (!/application\/octet-stream/i.test(response.headers.get('content-type') ?? '')) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const total = Number(response.headers.get('x-total-bytes'));
  const got = Number(response.headers.get('x-offset'));
  if (!Number.isSafeInteger(total) || got !== offset) throw new Error('This recording changed while it was read.');
  if (bytes.length > asked || (bytes.length === 0 && offset < total)) throw new Error('This recording could not be read completely.');
  return { bytes, total, offset };
}
