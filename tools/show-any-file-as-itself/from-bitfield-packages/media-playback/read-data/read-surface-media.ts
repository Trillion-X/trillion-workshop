import { readMediaSource, type MediaSourceRecord } from '../../../read-data/read-media-playback.ts';

// Pure adapter: a caller-supplied surfaceInput object -> MediaSourceRecord.
// Used by the placeable-surface mount entry so a placer (e.g. an AI fence) can
// hand the surface a media reference. Delegates to the canonical `readMediaSource`
// (SSOT) so the FULL record is preserved: embed_control (the object that carries
// cc_load_policy:0 plus the post-message command map), embed_control_ref,
// transcript_ref, content_ref, and every other field the player needs. An earlier
// string-whitelist copy here silently dropped those object fields, which
// re-enabled YouTube's native captions and hid the Transcript button. A bare url
// with no id is still accepted by deriving the id from whichever url field is
// present. Returns undefined when nothing playable was supplied (the surface then
// shows its empty state).
export function readSurfaceMedia(value: unknown): MediaSourceRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const str = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : undefined);
  const hasId = typeof row.id === 'string' && (row.id as string).trim().length > 0;
  // Derive an id from a url field only when the record has none, so a bare url
  // still plays while a full record keeps its own id.
  const derivedId = hasId ? undefined : (str('embed_url') ?? str('playback_url') ?? str('source_url'));
  if (!hasId && !derivedId) return undefined;
  const media = readMediaSource(hasId ? row : { ...row, id: derivedId });
  if (!media) return undefined;
  // A url with no declared kind still plays: default to video so the element
  // renders. Callers override by supplying mime_type / source_kind.
  if (!media.source_kind && !media.mime_type && (media.source_url || media.playback_url)) {
    media.source_kind = 'video';
  }
  return media;
}
