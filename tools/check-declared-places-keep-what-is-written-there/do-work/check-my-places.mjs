// tools/check-a-project-for-drift-and-broken-promises/do-work/check-my-places.mjs
//
// Several places are declared writable on the promise that something keeps what is written there: which keep
// nothing. Run by the Workshop tool `tool:check-declared-places-keep-what-is-written-there` on the person's computer:
//
//   node do-work/check-my-places.mjs <the granted folder> < <the input as JSON>
//
// Input: { declaration | declaration_file, places_key, id_key, bases, retention_kinds, exemptions?, remedy_hint? }
//   declaration       the JSON that lists the places (or declaration_file, a path inside the granted folder to it),
//                     read by KEY at any depth, so this file never learns another owner's layout
//   places_key/id_key the key holding the list of places and the key naming each place
//   bases             folders, relative to the granted folder, a place may live under ("" is the folder itself)
//   retention_kinds   [{ kind, marker }]: a kind keeps what is written when its marker (a child name, a file or a
//                     folder) is present at the place or at any ancestor up to the granted folder
//   exemptions        [{ place, why }]: a place that keeps nothing on purpose, with its reason; it is still examined
// The granted folder is the bound the places resolve against and the ancestor walk stops at, so one fact is both. It
// prints { result } on its last line, or { error } when nothing was examined: reading zero places is a refusal, never
// a pass. This is the disk half; every decision is in check-declared-places-keep-what-is-written-there.mjs.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { placesIn, resolvedPlaces, retentionReport } from './check-declared-places-keep-what-is-written-there.mjs';

const folder = process.argv[2];
const isDirectory = (candidate) => statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;

// The ancestor chain, bounded at the granted folder. Unbounded it reaches the filesystem root and can find an
// unrelated marker, which reports an uncovered place as covered.
function ancestorsUpTo(stopAt) {
  return (directory) => {
    const chain = [];
    let at = path.resolve(directory);
    while (at !== stopAt && at !== path.dirname(at)) {
      at = path.dirname(at);
      chain.push(at);
    }
    return chain;
  };
}

const within = (candidate) => path.relative(folder, candidate) || '.';
const relativeRow = (row) => ({ ...row, directory: within(row.directory) });

try {
  if (!folder || !path.isAbsolute(folder) || !isDirectory(folder)) {
    throw new Error('the granted folder was not given as an absolute path to a folder');
  }
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const need = (name) => { if (!input[name]) throw new Error(`give ${name}`); return input[name]; };
  const placesKey = need('places_key');
  const idKey = need('id_key');
  const retentionKinds = need('retention_kinds');
  const bases = Array.isArray(input.bases) && input.bases.length ? input.bases : [''];
  let declaration = input.declaration;
  if (declaration === undefined) {
    const file = path.resolve(folder, need('declaration_file'));
    if (!file.startsWith(folder + path.sep) || !existsSync(file)) {
      // A REFUSAL, not a pass: a checker whose input silently became unreadable reports zero findings.
      throw new Error(`the declaration is not at ${JSON.stringify(input.declaration_file)} inside the granted folder; nothing was examined, which is not the same as nothing being wrong`);
    }
    declaration = JSON.parse(readFileSync(file, 'utf8'));
  }
  const places = placesIn(declaration, { placesKey, idKey });
  // The denominator travels with the count, so a wrong key cannot print what a clean corpus prints.
  if (places.length === 0) throw new Error(`read 0 places at ${placesKey}; a key that matches nothing reports clean, so check the key before believing this`);
  const report = retentionReport(
    resolvedPlaces(places, { bases, home: folder, join: path.join, isDirectory }),
    {
      kinds: retentionKinds,
      marker: (directory, marker) => existsSync(path.join(directory, marker)),
      ancestorsOf: ancestorsUpTo(folder),
      exemptions: input.exemptions ?? [],
    },
  );
  console.log(JSON.stringify({
    result: {
      passed: report.keepsNothingCount === 0,
      places_declared: places.length,
      examined_count: report.examinedCount,
      keeps_nothing_count: report.keepsNothingCount,
      unresolved_count: report.unresolvedCount,
      examined: report.examined.map(relativeRow),
      keeps_nothing: report.keepsNothing.map(relativeRow),
      unresolved: report.unresolved,
      remedy_hint: input.remedy_hint ?? null,
    },
  }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
