// src/workspace/tool-results.ts
//
// PURPOSE
//   What a person reads of a run's result on a tool's own screen (src/workspace/tool-screen.tsx): the fields the
//   screen names in `shows`, and every file the run kept pulled out of them so it is shown as the file itself (the
//   shared KeptFiles view), never as its identity, size and type. Pure: no page, no markup.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a tool or a field. A kept file is known by its shape (an object holding a string
//      `identity`, a string `name` and a `media_type`), wherever in the result it sits.
//   2. A kept file never shows as data; what is left after the files are taken out shows only when something is left.

const empty = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as object).length);

/** What a person reads of a run's result: the fields the screen names in `shows` (all of them when it names none),
 *  never an empty one, and a single field as itself (a sentence reads as a sentence). */
export function shownResult(output: unknown, shows?: string[]): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const fields = Object.entries(output as Record<string, unknown>).filter(([name, value]) => (!shows || shows.includes(name)) && !empty(value));
  const ordered = shows ? fields.sort(([a], [b]) => shows.indexOf(a) - shows.indexOf(b)) : fields;
  return ordered.length === 1 ? ordered[0][1] : Object.fromEntries(ordered);
}

/** A file a run kept in the person's files. */
export type KeptFileRecord = { identity: string; name: string; media_type: string | null };
const isKept = (value: unknown): value is KeptFileRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && typeof (value as KeptFileRecord).identity === 'string' && typeof (value as KeptFileRecord).name === 'string' && 'media_type' in (value as object);

/** The kept files anywhere in a shown result, in order, and what is left without them (undefined when nothing is). */
export function splitKeptFiles(value: unknown): { files: KeptFileRecord[]; rest: unknown } {
  const files: KeptFileRecord[] = [];
  const walk = (at: unknown): unknown => {
    if (isKept(at)) { files.push(at); return undefined; }
    if (Array.isArray(at)) { const kept = at.map(walk).filter(item => item !== undefined); return kept.length ? kept : undefined; }
    if (at && typeof at === 'object') {
      const kept = Object.entries(at as Record<string, unknown>).map(([name, item]) => [name, walk(item)] as const).filter(([, item]) => item !== undefined);
      return kept.length ? Object.fromEntries(kept) : undefined;
    }
    return empty(at) ? undefined : at;
  };
  const rest = walk(value);
  return { files, rest };
}
