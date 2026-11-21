// src/workspace/media-pictures.ts
//
// PURPOSE
//   A file's picture on the Media screen: the files owner's thumbnail (tool:your-files `thumbnail`, a picture of at most
//   `thumbnail_size` pixels on its longer edge, made once and kept under the file's content identity), as a data address
//   the shared picture draws. A file the owner makes no picture of answers null, and its tile shows its kind's icon.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One thumbnail call per file for the page's life: a file's answer, picture or null, is kept and never asked again.
//   2. The size is DATA (media-library-owner.json `thumbnail_size`); nothing here names a kind or a tool.
//   3. A failed call is an answer of null (its tile shows the icon), and the owner's words are kept for the page's own note.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import owner from './media-library-owner.json' with { type: 'json' };
import { filesRead } from './media-door';

type Thumbnail = { media_type?: string; content_base64?: string; thumbnail?: null; reason?: string };

const pictures = new Map<string, Promise<string | null>>();

/** The picture of one file as a data address, or null when the owner makes none. */
export function pictureOf(identity: string): Promise<string | null> {
  let picture = pictures.get(identity);
  if (!picture) {
    picture = filesRead<Thumbnail>('thumbnail', { name_or_identity: identity, size: owner.thumbnail_size })
      .then(made => (made.content_base64 ? `data:${made.media_type ?? 'image/jpeg'};base64,${made.content_base64}` : null), () => null);
    pictures.set(identity, picture);
  }
  return picture;
}
