// tools/run-on-a-persons-computer/side-files.mjs (moved from Trillion-X/trillion src/side-files.mjs)
//
// PURPOSE
//   Knows the files a device writes beside a recording that are not recordings of their own (a camera's smaller proxy
//   copy, its thumbnail picture) and which original each belongs to, from the rows in side-files.json. The drive keeper
//   (./keep-drive-files.mjs) reads it: it never sends a side file whose original is on the same drive.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No device, brand or folder is named here. Every layout is a row of side-files.json; a new camera is one row.
//   2. A side file whose row says `when_original_present` is only dropped when an original is there: a proxy recorded
//      on a card of its own may be the only copy of that recording.
//   3. Nothing is erased. A dropped side file is set aside (recoverable), and its results stay under its identity; the
//      original keeps whichever result is more complete.
//   4. A path matches a row at its end, starting at a folder boundary, so the same row holds wherever the device's
//      folders sit (the drive's root, PRIVATE/ on a card, /Recordings/<drive>/ in the namespace).
//
// KEY CONCEPTS
//   template  a path tail with `{part}` places: one or more characters inside one folder or file name. Literal text
//             matches without regard to letter case, as camera file systems do.
//   side      what sideOf(path) answers: { path, rows, originals: candidate original paths, drop, carry }
//
import defaults from './side-files.json' with { type: 'json' };

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PART = /\{([a-z][a-z0-9_]*)\}/gi;

// One template as a matcher over a whole path: the path's start up to a folder boundary is the `root`, then the
// template, each `{part}` a named group inside one name. A part named twice must hold the same text both times.
function compile(template) {
  const parts = [];
  let source = '', at = 0;
  for (const found of template.matchAll(PART)) {
    source += escape(template.slice(at, found.index));
    const index = parts.indexOf(found[1]);
    source += index < 0 ? '([^/]+)' : `\\${index + 2}`;
    if (index < 0) parts.push(found[1]);
    at = found.index + found[0].length;
  }
  source += escape(template.slice(at));
  const pattern = new RegExp(`^((?:.*/)?)${source}$`, 'i');
  return path => {
    const match = pattern.exec(path);
    if (!match) return null;
    return { root: match[1], parts: Object.fromEntries(parts.map((part, index) => [part, match[index + 2]])) };
  };
}

// A template filled with the parts found, under the same root; null when it names a part that was not found. Literal
// text is written as the row writes it, and once more in lower case, so a card written in lower case is found too.
function fill(template, root, parts) {
  if ([...template.matchAll(PART)].some(found => !(found[1] in parts))) return [];
  const as = transform => root + template.split(PART).map((piece, index) => (index % 2 ? parts[piece] : transform(piece))).join('');
  return [...new Set([as(text => text), as(text => text.toLowerCase())])];
}

/**
 * The side-file rules over `rows` (side-files.json rows unless given):
 *   sideOf(path)    -> { path, rows: [row id], originals: [path], drop, carry: [kind] } when `path` is a side file
 *   sidesFor(path)  -> [path]: the side files a file at `path` (an original) would have, by every row
 * `drop` is `always` only when every matching row says so; `carry` joins every matching row's kinds.
 */
export function sideFiles(rows = defaults.rows) {
  const compiled = rows.map(row => ({ row, side: compile(row.side), originals: row.originals.map(template => ({ template, match: compile(template) })) }));
  return {
    sideOf(path) {
      const matched = compiled.map(rule => ({ rule, found: rule.side(path) })).filter(({ found }) => found);
      if (!matched.length) return null;
      return {
        path,
        rows: matched.map(({ rule }) => rule.row.id),
        originals: [...new Set(matched.flatMap(({ rule, found }) => rule.row.originals.flatMap(template => fill(template, found.root, found.parts))))].filter(original => original !== path),
        drop: matched.every(({ rule }) => rule.row.drop === 'always') ? 'always' : 'when_original_present',
        carry: [...new Set(matched.flatMap(({ rule }) => rule.row.carry ?? []))],
      };
    },
    sidesFor(path) {
      const sides = [];
      for (const rule of compiled) for (const original of rule.originals) {
        const found = original.match(path);
        if (found) sides.push(...fill(rule.row.side, found.root, found.parts));
      }
      return [...new Set(sides)].filter(side => side !== path);
    },
  };
}
