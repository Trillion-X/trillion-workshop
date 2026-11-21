// src/workspace/media-playback.ts
//
// PURPOSE
//   A recording's bytes for playing on the Media screen: read from the files owner by range (tool:your-files `read_file_span`,
//   `span_bytes` a window) and kept as one object address the player takes. A recording from any time plays: the bytes come
//   from the store the owner reads, not from a retired route.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading only, one window after another, never two at once beyond the door's slots (media-door.ts).
//   2. A file whose length changed while it was read, or that is larger than `most_playable_bytes`, is refused, never played cut short.
//   3. One address per file for the page's life: a second ask gets the same address.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };
import { filesRead } from './media-door';

type Span = { byte_length: number; bytes_returned: number; content: string };

const playable = new Map<string, Promise<string>>();

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

async function wholeFile(identity: string, mediaType: string | null): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let total: number | null = null;
  do {
    const span = await filesRead<Span>('read_file_span', { name_or_identity: identity, offset, length: owner.span_bytes });
    total ??= span.byte_length;
    if (span.byte_length !== total) throw new Error('This recording changed while it was read.');
    if (total > owner.most_playable_bytes) throw new Error('This recording is too large to play here.');
    if (!span.bytes_returned && offset < total) throw new Error('This recording could not be read completely.');
    const bytes = bytesOf(span.content);
    parts.push(bytes);
    offset += bytes.length;
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
