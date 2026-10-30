// tools/connected-drives/read-data/file-kinds.mjs
//
// Purpose: what kind of file a name is (Videos, Audio, Pictures, ...), read from file-kinds.json. The kinds, their
// labels, their extensions and the system folders a drive walk skips are DATA in that file; nothing here names one.
// A name whose extension no kind lists is `other`. Some kinds are folders on macOS (a Final Cut library, an app), so
// a folder whose extension a kind lists is that kind too.
//
// Exports: fileKinds (the parsed DATA), kindOf(name) -> kind id, kindLabel(kind) -> label.
import fileKindsData from './file-kinds.json' with { type: 'json' };

export const fileKinds = fileKindsData;
const byExtension = new Map(fileKinds.kinds.flatMap(row => row.extensions.map(extension => [extension.toLowerCase(), row.kind])));
const labels = new Map([...fileKinds.kinds.map(row => [row.kind, row.label]), [fileKinds.other.kind, fileKinds.other.label]]);

export function kindOf(name) {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 ? byExtension.get(String(name).slice(dot + 1).toLowerCase()) ?? fileKinds.other.kind : fileKinds.other.kind;
}

/** The kind of a folder that is itself one document (a package), or null for an ordinary folder. */
export function folderKindOf(name) {
  const kind = kindOf(name);
  return kind === fileKinds.other.kind ? null : kind;
}

export const kindLabel = kind => labels.get(kind) ?? fileKinds.other.label;
