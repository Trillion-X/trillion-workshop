// parts/ui/show/file-field/takes-file.mjs
//
// PURPOSE
//   Whether a file is of the kind an input takes, decided once for every place that asks: the file field's chooser and
//   drop guard (FileField.tsx), and the Worker choosing which Workshop tools to offer on a file's card
//   (src/work-workshop.mjs fileActions). What each kind takes is DATA (file-takes.json `takes`); a file with no media
//   type is known by the ending of its name (../file-chip/file-kinds.json `endings`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Names no kind of file: a new kind is a row in file-takes.json, a new ending a row in file-kinds.json.
//   2. Plain JavaScript with JSON imports only, so the browser bundle and the Worker load the same file.
import settings from './file-takes.json' with { type: 'json' };
import kinds from '../file-chip/file-kinds.json' with { type: 'json' };

const TAKES = settings.takes;
const endingType = name => (String(name ?? '').includes('.') ? kinds.endings[String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase()] ?? '' : '');

/** Whether a file of this media type (or, without one, this name) is one of `accept` (`type/*` is every type under
 *  `type/`; an empty list takes any file). */
export function takesFile(accept, mediaType, name) {
  if (!accept.length) return true;
  const type = String(mediaType || endingType(name)).toLowerCase().split(';')[0].trim();
  return accept.some(pattern => (pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern));
}

/** What a `takes` id means: its media types and its word for one file; an unknown id takes any file. */
export const takesOf = takes => TAKES[takes ?? ''] ?? TAKES.any;
