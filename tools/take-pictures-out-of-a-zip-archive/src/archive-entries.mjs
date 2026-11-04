// src/archive-entries.mjs
//
// PURPOSE
//   The files inside a zip archive, as bytes: { title, media_type, bytes } for each entry an importer may take, so a
//   folder of pictures is brought in the way a single picture is (through the importer's one pipeline), not unpacked.
//   Which entries count, and the limits, are DATA (src/archive-entries.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. An entry's name is never a path: nothing here writes, resolves or returns it as one. It is used only to derive a
//      title (its last segment without the extension), so `../../x.png` and absolute names have no traversal to exploit.
//   2. Only entries of an admitted extension are read; archive litter (skip patterns) and directories never are.
//      Bytes of a refused entry are never inflated.
//   3. Bounded: entry count, one entry's bytes, all bytes, and the expansion ratio are limited; an archive over a limit
//      stops with the reason, naming the limit, and keeps nothing half-read.
import { unzipSync } from 'fflate';
import rules from './archive-entries.json' with { type: 'json' };

const SKIP = rules.skip.map(pattern => new RegExp(pattern));
const extensionOf = name => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
const titleOf = name => {
  const last = name.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return last.replace(/\.[a-z0-9]+$/i, '').trim() || 'Untitled';
};

export class ArchiveRefused extends Error {}

/** The admitted entries of a zip archive (Uint8Array), in archive order. Throws ArchiveRefused past a limit. */
export function archiveEntries(zip, limits = rules) {
  limits = { ...rules, ...limits };
  const admitted = [];
  let total = 0;
  let refusal = null;
  const refuse = message => { refusal ??= message; return false; };
  let files;
  try {
    files = unzipSync(zip, { filter: file => {
      if (refusal || file.name.endsWith('/') || SKIP.some(pattern => pattern.test(file.name))) return false;
      if (!limits.media_types[extensionOf(file.name)]) return false;
      if (limits.title_prefix && !titleOf(file.name).startsWith(limits.title_prefix)) return false;
      if (admitted.length >= limits.max_entries) return refuse(`The archive holds more than ${limits.max_entries} files.`);
      if (file.originalSize > limits.max_entry_bytes) return refuse(`${titleOf(file.name)} is larger than ${limits.max_entry_bytes} bytes.`);
      if (file.size > 0 && file.originalSize / file.size > limits.max_ratio) return refuse(`${titleOf(file.name)} expands too far.`);
      total += file.originalSize;
      if (total > limits.max_total_bytes) return refuse(`The archive expands past ${limits.max_total_bytes} bytes.`);
      admitted.push(file.name);
      return true;
    } });
  } catch (error) { throw new ArchiveRefused(refusal ?? `This is not a readable zip archive: ${error.message}`); }
  if (refusal) throw new ArchiveRefused(refusal);
  return admitted.map(name => ({ title: titleOf(name), media_type: limits.media_types[extensionOf(name)], bytes: files[name] }));
}

/** The named profile of limits (archive-entries.json `profiles`). */
export const profile = name => ({ ...rules, ...rules.profiles[name] });
