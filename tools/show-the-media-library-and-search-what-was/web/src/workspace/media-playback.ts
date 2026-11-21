// src/workspace/media-playback.ts
//
// PURPOSE
//   A recording's bytes for playing on the Media screen: read from the files owner by range (tool:your-files `read_file_span`,
//   `span_bytes` a window, which fits the door's reply) and kept as one object address the player takes. Each recording is
//   read whole into memory, so only a recording under `most_playable_bytes` (DATA) plays here; a larger one has no play
//   control. A service worker that serves ranges on demand is not built: the Mac's web view is not verified for one.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading only, one window after another, never two at once beyond the door's slots (media-door.ts).
//   2. A file whose length changed while it was read is refused, never played cut short.
//   3. One address per file for the page's life: a second ask gets the same address.
//   4. A recording whose length is not known, or is over the limit, is not playable (canPlay is false).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };
import { filesRead } from './media-door';
import { pass } from '../../../../workspace-screens/web/src/workspace/account-pass';
import { readRawSpan } from './media-raw-span';

type Span = { byte_length: number; bytes_returned: number; content: string };

const playable = new Map<string, Promise<string>>();
const lengths = new Map<string, number>();

/** Remember a file's length when a read or a search first names it. */
export const noteLength = (identity: string, bytes: number) => { lengths.set(identity, bytes); };

/** Whether a recording can play here: its length is known and under the DATA limit. */
export const canPlay = (identity: string) => (lengths.get(identity) ?? Infinity) <= owner.most_playable_bytes;

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

// One window of a recording from `offset`: the raw body when raw_spans is on and the answer is raw, else the JSON window.
async function windowOf(identity: string, offset: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; total: number }> {
  if (owner.raw_spans) {
    const raw = await readRawSpan(fetch, await pass(), identity, offset, owner.raw_span.window_bytes);
    if (raw) return { bytes: raw.bytes, total: raw.total };
  }
  const span = await filesRead<Span>('read_file_span', { name_or_identity: identity, offset, length: owner.span_bytes });
  if (!span.bytes_returned && offset < span.byte_length) throw new Error('This recording could not be read completely.');
  return { bytes: bytesOf(span.content), total: span.byte_length };
}

async function wholeFile(identity: string, mediaType: string | null): Promise<Blob> {
  const parts: BlobPart[] = [];
  let offset = 0;
  let total: number | null = null;
  do {
    const window = await windowOf(identity, offset);
    total ??= window.total;
    if (window.total !== total) throw new Error('This recording changed while it was read.');
    parts.push(window.bytes);
    offset += window.bytes.length;
  } while (offset < total);
  return new Blob(parts, { type: mediaType ?? 'application/octet-stream' });
}

/** The address one recording plays from, read once and kept for the page's life. */
export function playableUrl(identity: string, mediaType: string | null): Promise<string> {
  let url = playable.get(identity);
  if (!url) {
    url = wholeFile(identity, mediaType).then(blob => URL.createObjectURL(blob), error => { playable.delete(identity); throw error; });
    playable.set(identity, url);
  }
  return url;
}
