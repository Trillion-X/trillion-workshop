// tools/show-any-file-as-itself/read-data/read-surface-media.ts
//
// PURPOSE
//   Turns a surface input (a media reference a placer hands the player, such as an AI fence or a page's inline video)
//   into the media record the shared player draws. It delegates to readMediaSource, so every field the player needs
//   (embed_control with its caption flag and command map, embed_control_ref, transcript_ref, content_ref, and the rest)
//   is kept. A bare address with no id still plays: its id is taken from the first address field present. A record
//   that names nothing playable returns undefined, so the surface shows its empty state.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readMediaSource, type MediaSourceRecord } from './read-media-playback.ts';

export function readSurfaceMedia(value: unknown): MediaSourceRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const str = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : undefined);
  const hasId = typeof row.id === 'string' && (row.id as string).trim().length > 0;
  // An id is derived from an address only when the record has none, so a full record keeps its own id.
  const derivedId = hasId ? undefined : (str('embed_url') ?? str('playback_url') ?? str('source_url'));
  if (!hasId && !derivedId) return undefined;
  const media = readMediaSource(hasId ? row : { ...row, id: derivedId });
  if (!media) return undefined;
  // An address with no declared kind still plays: it is a video, so the element renders. A caller overrides it with
  // mime_type or source_kind.
  if (!media.source_kind && !media.mime_type && (media.source_url || media.playback_url)) {
    media.source_kind = 'video';
  }
  return media;
}
