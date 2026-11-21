// src/workspace/media-pictures.ts
//
// PURPOSE
//   A file's picture on the Media screen: the files owner's thumbnail (tool:your-files `thumbnail`, a picture of at most
//   `thumbnail_size` pixels on its longer edge, made once and kept under the file's content identity), as a data address
//   the shared picture draws. A file the owner makes no picture of answers null, and its tile shows its kind's icon.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One thumbnail call per file for the page's life: a file's answer, picture or null, is kept and never asked again.
//   2. A failed call opens a circuit: for `thumbnail_retry_seconds` (media-library-owner.json) no thumbnail is asked for,
//      and every file answers null at once. The owner's failure is not hammered once per tile.
//   3. The size and the interval are DATA; nothing here names a kind or a tool.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };
import { filesRead } from './media-door';

type Thumbnail = { media_type?: string; content_base64?: string; thumbnail?: null; reason?: string };

const pictures = new Map<string, Promise<string | null>>();
let circuitOpenUntil = 0;

/** The picture of one file as a data address, or null when the owner makes none or is not being asked. */
export function pictureOf(identity: string): Promise<string | null> {
  if (Date.now() < circuitOpenUntil) return Promise.resolve(null);
  let picture = pictures.get(identity);
  if (!picture) {
    picture = filesRead<Thumbnail>('thumbnail', { name_or_identity: identity, size: owner.thumbnail_size })
      .then(made => (made.content_base64 ? `data:${made.media_type ?? 'image/jpeg'};base64,${made.content_base64}` : null), () => {
        circuitOpenUntil = Date.now() + owner.thumbnail_retry_seconds * 1000;
        pictures.delete(identity);
        return null;
      });
    pictures.set(identity, picture);
  }
  return picture;
}
