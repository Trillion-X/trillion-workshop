// Report declared paths that do not resolve.
//
// A record somewhere says "my bytes come from HERE". Nothing checks that HERE exists until
// something downstream tries to read it, and downstream readers of a missing path have a bad
// habit of skipping rather than complaining, because at that point the reader is in a loop and
// `continue` is the shortest thing to type. A path that names nothing is then indistinguishable
// from a path that names something correct.
//
// This file knows no field name, no record shape, no product and no package. The caller says
// WHICH keys carry a path and WHERE paths are resolved from; this walks any JSON and reports the
// values at those keys that do not resolve. The same code answers "which image sources in this
// manifest are dead", "which include paths in this build config point nowhere" and "which asset
// references in this bundle were renamed away", because none of those differ in anything but the
// key names, which are DATA.
//
// TWO REFUSALS, and they are the whole design:
//
//   1. NO DISCOVERY. The caller supplies the documents. Absorbing discovery pulls in git or not,
//      worktrees, ignore rules and symlinks, and makes this untestable without a disk.
//   2. NO REPAIR. Knowing a path is dead says nothing about what it was meant to be. A guess
//      here would be written into a record that other things trust.

import { existsSync } from 'node:fs';
import path from 'node:path';

/** Every value in a document sitting at one of the named keys, with the route taken to reach it.
 *
 *  The route is carried because a report saying "a path is dead" and not saying WHERE it was
 *  declared sends the reader to grep for a string that appears in three hundred files. It is a
 *  LIST of steps rather than a dotted string: a key containing a dot would make the joined form
 *  ambiguous, and re-splitting it is the parse this codebase refuses to write.
 *
 *  Walks arrays and objects alike, because a document nests both ways and a walker that handles
 *  only one silently covers half the corpus. That is not hypothetical: the five documents whose
 *  payload is an ARRAY rather than an object are exactly the ones a shallow object-only reader
 *  reports as clean. */
export function* valuesAtKeys(document, keys, route = [], eachInKeys = []) {
  if (document === null || typeof document !== 'object') return;

  if (Array.isArray(document)) {
    for (const [index, item] of document.entries()) yield* valuesAtKeys(item, keys, [...route, index], eachInKeys);
    return;
  }

  for (const [key, value] of Object.entries(document)) {
    // A named key holding a string is a declaration. A named key holding an object is not one,
    // and it is also not an error: it is a different shape that this caller did not name.
    if (keys.includes(key) && typeof value === 'string') {
      // `key` is carried BESIDE the route rather than read back off its end. Once a list entry
      // appends an index, the last step of a route is a number and any caller grouping by
      // "the last thing in the route" starts counting under `0` and `1`.
      yield { route: [...route, key], key, value };
      continue;
    }
    // A key named in `eachInKeys` holds MANY addresses, one per entry. The route carries the
    // INDEX, so a dead entry says which one rather than sending a reader to count list items.
    //
    // WHY THIS IS A SEPARATE ARGUMENT AND NOT "a list at a named key is a list of declarations",
    // which is what it was for about ten minutes on 2026-09-09. A LIST OF STRINGS HAS TWO
    // MEANINGS IN THIS CORPUS AND NOTHING IN ITS SHAPE TELLS THEM APART. `checks` holds many file
    // addresses. `source_path` on an interpreter projection holds ONE record address written as
    // segments, `["current-item", "published-record"]`, and a relationship descriptor's `id` does
    // the same. Treating every list as many addresses reported 10 dead paths and all 10 were
    // those segments, which is the identical false-findings failure this file was already
    // rebuilt once to stop, and a report whose findings are all false gets deleted along with the
    // real finding it would have caught later.
    //
    // So WHICH MEANING A KEY CARRIES IS THE CALLER'S FACT, exactly like `bases` and `suffixes`,
    // and for the same reason: it belongs to the reader, never to the declaration.
    if (eachInKeys.includes(key) && Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === 'string') yield { route: [...route, key, index], key, value: item };
        else yield* valuesAtKeys(item, keys, [...route, key, index], eachInKeys);
      }
      continue;
    }
    yield* valuesAtKeys(value, keys, [...route, key], eachInKeys);
  }
}

/** Every place one declared value could legitimately land.
 *
 *  A DECLARATION IS NOT A PATH, IT IS AN ADDRESS THAT SOME READER RESOLVES, and the resolution
 *  rule lives with the reader, not with the declaration. Assuming one base and an exact spelling
 *  is the mistake this function exists to stop making, and it was measured rather than imagined:
 *  the first run of this check reported 39 findings and every single one was wrong, in two ways at
 *  once. Some values omit a suffix the reader appends. Others are rooted at an enclosing folder
 *  rather than the document's own, so joining them to the document's folder produces a path with
 *  the folder name in it twice, which of course does not exist.
 *
 *  A report whose findings are all false is worse than no report, because it is deleted along with
 *  the real finding it would have caught later.
 *
 *  So both are DATA. `bases` are the roots a reader might resolve against; `suffixes` are what a
 *  reader might append, with the empty string meaning "exactly as written". Nothing here knows a
 *  folder name or a file extension, and a corpus with different conventions is a different
 *  argument rather than a different function. Resolution is a CROSS PRODUCT and any hit counts,
 *  because the question is whether the declaration names something real, not which reader wins. */
export function candidateResolutions(value, { bases, suffixes }) {
  if (path.isAbsolute(value)) return suffixes.map((suffix) => `${value}${suffix}`);
  return bases.flatMap((base) => suffixes.map((suffix) => `${path.join(base, value)}${suffix}`));
}

/** Declared paths in one document that resolve to nothing under any candidate.
 *
 *  `exists` is injected so this is testable without a disk, which is the same reason the caller
 *  owns discovery. An absolute declared value keeps its own root: silently re-rooting one under a
 *  base would report a working path as dead. */
export function unresolvedPathsInDocument({ document, keys = [], eachInKeys = [], bases, suffixes = [''], source = null, exists = existsSync }) {
  if (!Array.isArray(keys) || !Array.isArray(eachInKeys) || keys.length + eachInKeys.length === 0) {
    throw new Error('NO_KEYS_NAMED: a caller must name which keys carry a path, in keys when the value IS one address or in eachInKeys when the value is a list of them, or this reports nothing and looks clean');
  }
  if (!Array.isArray(bases) || bases.length === 0 || bases.some((base) => typeof base !== 'string' || base === '')) {
    throw new Error('NO_BASES_NAMED: relative addresses cannot be resolved without at least one base, and defaulting to the working directory makes the answer depend on where this was run from');
  }
  if (!Array.isArray(suffixes) || suffixes.length === 0) {
    throw new Error('NO_SUFFIXES_NAMED: pass [""] for exact spelling; an empty list can resolve nothing and would report the whole corpus dead');
  }

  const unresolved = [];
  for (const { route, value } of valuesAtKeys(document, keys, [], eachInKeys)) {
    const tried = candidateResolutions(value, { bases, suffixes });
    if (!tried.some((candidate) => exists(candidate))) unresolved.push({ source, route, declared: value, tried });
  }
  return unresolved;
}

/** The same across many documents, each with its own bases.
 *
 *  Each entry is `{source, document, bases}` because in the usual case a document resolves against
 *  its OWN folder plus whatever encloses it, and those differ per document. */
export function unresolvedPathsAcrossDocuments(documents, keys, suffixes = [''], exists = existsSync, eachInKeys = []) {
  return documents.flatMap(({ source, document, bases }) =>
    unresolvedPathsInDocument({ document, keys, eachInKeys, bases, suffixes, source, exists }));
}

/** How many declarations each named key actually produced. THE DENOMINATOR.
 *
 *  `unresolvedPathsInDocument` already refuses an EMPTY key list, in its own words, because it
 *  "reports nothing and looks clean". A key list that is full but WRONG produces the identical
 *  outcome and was not refused: measured 2026-09-09, asking this report about `--keys check_files`
 *  when the field is called `checks` printed output byte-identical to a genuinely clean package,
 *  and the only way to tell them apart was to open the document by hand.
 *
 *  A count of failures with no count of attempts cannot distinguish "nothing is wrong" from "the
 *  question was never asked", and those two are the same output in every reporting tool that has
 *  ever quietly stopped working. So the denominator is not a nicety here, it is the difference
 *  between an answer and a shrug.
 *
 *  PER KEY rather than a total, because a caller naming four keys of which one is misspelled is
 *  the common case and a single total hides it behind the three that worked. Counted through the
 *  SAME walker that finds the values, so a key shape one of them handles and the other does not
 *  cannot exist. */
export function declaredPathCountsByKey(documents, keys, eachInKeys = []) {
  const counts = Object.fromEntries([...keys, ...eachInKeys].map((key) => [key, 0]));
  for (const { document } of documents) {
    for (const { key } of valuesAtKeys(document, keys, [], eachInKeys)) counts[key] += 1;
  }
  return counts;
}
