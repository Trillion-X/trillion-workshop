// src/file-type.mjs
//
// A file's content type, known by Trillion rather than taken on trust from whoever sent it.
//
// Many senders label a file only as "some bytes" (application/octet-stream) or say nothing: a camera's own clip format
// the sending computer does not recognise (macOS `file` calls some camera .MP4 clips octet-stream), a voice memo
// attached to a mail. Trusting that label hides the file from everything that works by type: transcribing what is
// said, previews, the rules that start work when a video arrives. So a type that says nothing gives way to the type
// the file's name gives, read from the one table the Files screen already uses
// (workspace/file-previews.json content_types_by_extension). A specific type the sender gave wins unless the file's
// measured WebM tracks contradict its audio/video label; a name with no known extension keeps what was said.
//
// Invariants: pure, no I/O; a new format is one row in file-previews.json, never a code change here.
import filePreviews from '../../keep-and-wake-ai-sessions-on-this-computer/src/workspace/file-previews.json' with { type: 'json' };

export const GENERIC_TYPE = 'application/octet-stream';

const typeOfName = name => filePreviews.content_types_by_extension[/\.([^./]+)$/.exec(String(name ?? ''))?.[1].toLowerCase()] ?? null;

/** The type to treat a file as: `said` unless it is missing or generic, else the first type one of `names` gives. */
export function fileType(said, names) {
  if (said && said !== GENERIC_TYPE) return said;
  for (const name of Array.isArray(names) ? names : [names]) {
    const known = typeOfName(name);
    if (known) return known;
  }
  return said || null;
}

/** A WebM's measured tracks correct an inaccurate sender label without guessing from its name.
 *  An unread or malformed container keeps its existing type; only the file's own TrackType facts can override it. */
export function observedMediaType(said, facts) {
  if (!/^(audio|video)\/webm(?:;|$)/i.test(String(said ?? ''))) return said;
  const kind = observedMediaKind(facts);
  if (kind) return `${kind}/webm`;
  return said;
}

/** Picture wins when a file has both kinds of track, because its tile and player must show the picture. */
export function observedMediaKind(facts) {
  const tracks = facts?.media_tracks;
  if (!Array.isArray(tracks)) return null;
  if (tracks.includes('video')) return 'video';
  if (tracks.includes('audio')) return 'audio';
  return null;
}
