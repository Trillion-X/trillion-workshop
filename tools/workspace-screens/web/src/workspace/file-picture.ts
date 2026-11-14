// src/workspace/file-picture.ts
//
// PURPOSE
//   What one of the person's files shows as its picture, wherever it is shown (Files, Home's New for you, Media, a
//   search result): its family from its stored media type or extension, the preview row for that family, its content type, the address its
//   bytes are read from, and the picture itself (filePicture).
//   All of it is DATA in file-previews.json; this file only reads it, so every screen shows a file the same way.

import filePreviews from './file-previews.json';
import { madeMediaPreviewContent, mediaPreviewContent } from '../../parts/ui/show/media-preview';
import { previewStore } from './made-previews';

export type FilePreviewRow = { family?: string; renderer: string; moment_renderer?: string; made?: boolean; icon: string; type_label: string; tree_tone?: string };

const families = filePreviews.families_by_extension as Record<string, string>;
const mediaFamilies = filePreviews.families_by_media_type_prefix as Record<string, string>;
const contentTypes = filePreviews.content_types_by_extension as Record<string, string>;
// A stored type that only says "some bytes" names nothing; the extension's type does.
const UNNAMED_TYPES = new Set(['', 'application/octet-stream']);

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;
export const extensionOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };

/** The preview row for a family: the first row naming it, else the row naming none. */
export const previewFor = (family: string): FilePreviewRow => (filePreviews.rows as FilePreviewRow[]).find(row => row.family === family)
  ?? (filePreviews.rows as FilePreviewRow[]).find(row => row.family === undefined)!;

/** A file's family from its stored type when that resolves an ambiguous media extension, then its extension. */
export const familyOf = (name: string, stored?: string | null) => Object.entries(mediaFamilies).find(([prefix]) => stored?.toLowerCase().startsWith(prefix))?.[1]
  ?? families[extensionOf(name)] ?? 'other';

/** The content type a file is shown as: the one it was stored with, else its extension's. */
export const contentTypeOf = (name: string, stored: string | null | undefined) => (UNNAMED_TYPES.has(stored ?? '') ? contentTypes[extensionOf(name)] ?? '' : stored!);

/** Where the person's page reads a stored file's bytes, by range. */
export const bytesAddress = (identity: string) => `/work/api/namespace/bytes/${encodeURIComponent(identity)}`;

/** One file as its picture: its kind's row picks the renderer; a kind whose pictures are made (a still, frames, a
 *  waveform, a first page, opening lines) reads them from the one made-preview store; a moment inside the file (`at`)
 *  uses the kind's `moment_renderer`; a file whose bytes are not here yet shows its kind's icon and `typeLabel`. */
export function filePicture(file: { name: string; kind?: string | null; mediaType?: string | null; identity?: string | null; bytes?: string | null; title?: string; at?: number; typeLabel?: string }) {
  const row = previewFor(file.kind ?? familyOf(file.name, file.mediaType));
  const tile = { renderer: row.renderer, title: file.title ?? file.name, icon: row.icon, typeLabel: file.typeLabel ?? row.type_label };
  if (!file.bytes) return mediaPreviewContent({ ...tile, renderer: 'type-icon' });
  if (file.at !== undefined && row.moment_renderer) return mediaPreviewContent({ ...tile, renderer: row.moment_renderer, source: file.bytes, at: file.at });
  if (row.made && file.identity) return madeMediaPreviewContent({ ...tile, identity: file.identity, url: file.bytes, contentType: contentTypeOf(file.name, file.mediaType), store: previewStore });
  return mediaPreviewContent({ ...tile, renderer: 'type-icon' });
}
