// tools/search: how a file's words are read, chosen by its media type first and its name's ending when the type names
// nothing. Pure: the rows are DATA (read-data/file-words.json), and this file names no kind of file. Ported from the
// older Workshop copy of src/file-words.mjs wayOf (commit b6ae0ebf81); the rows are the older Workshop copy's bytes.
import settings from '../read-data/file-words.json' with { type: 'json' };

/** The part of a name after its last dot, lower case; '' when there is none. */
const extensionOf = name => {
  const base = String(name ?? '').slice(String(name ?? '').lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** How a file with this media type and name is read ('as-text', 'converted'), or null when it is not read. */
export function wayOf({ media_type, name }, config = settings) {
  const type = String(media_type ?? '').split(';')[0].trim().toLowerCase();
  const named = !(config.unnamed_types ?? []).includes(type);
  const extension = extensionOf(name);
  const row = config.rows.find(candidate => (candidate.type_prefix !== undefined
    ? named && type.startsWith(candidate.type_prefix)
    : !named && (candidate.extensions ?? []).includes(extension)));
  return row?.way ?? null;
}
