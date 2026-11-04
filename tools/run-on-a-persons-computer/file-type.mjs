// tools/run-on-a-persons-computer/file-type.mjs (moved from Trillion-X/trillion src/file-type.mjs)
//
// A file's content type, known by Trillion rather than taken on trust from whoever sent it.
//
// Many senders label a file only as "some bytes" (application/octet-stream) or say nothing: a camera's own clip format
// the sending computer does not recognise (macOS `file` calls some camera .MP4 clips octet-stream), a voice memo
// attached to a mail. Trusting that label hides the file from everything that works by type: transcribing what is
// said, previews, the rules that start work when a video arrives. So a type that says nothing gives way to the type
// the file's name gives, read from ./file-type.json (the Files screen's content_types_by_extension). A specific type
// the sender gave wins; a name with no known extension keeps what was said.
//
// Invariants: pure, no I/O; a new format is one row in file-type.json, never a code change here.
import byName from './file-type.json' with { type: 'json' };

export const GENERIC_TYPE = 'application/octet-stream';

const typeOfName = name => byName.content_types_by_extension[/\.([^./]+)$/.exec(String(name ?? ''))?.[1].toLowerCase()] ?? null;

/** The type to treat a file as: `said` unless it is missing or generic, else the first type one of `names` gives. */
export function fileType(said, names) {
  if (said && said !== GENERIC_TYPE) return said;
  for (const name of Array.isArray(names) ? names : [names]) {
    const known = typeOfName(name);
    if (known) return known;
  }
  return said || null;
}
