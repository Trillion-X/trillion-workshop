// Discovery for the declared-path report. The check itself owns no discovery on purpose, so this
// is the thin half that touches a disk and the testable half stays testable.
//
// THE CALLER NAMES THE PACKAGES. It does not read the folder. The sibling runner beside this one
// records that its own first draft took `--every-package-in-the-source-set` and read the
// directory, and that scanning a folder for content is owned elsewhere (L136), so the same shape
// is refused here for the same reason rather than rediscovered.
//
// WHICH KEYS CARRY A PATH IS AN ARGUMENT, not a constant here. A default list would be the closed
// set this codebase refuses everywhere else, and it would go stale the first time a record grew a
// second path-bearing field, with nobody noticing the report had quietly stopped covering it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { declaredPathCountsByKey, unresolvedPathsAcrossDocuments } from './report-declared-paths-that-do-not-resolve.mjs';

export function argumentValues(argv, flag) {
  const found = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) found.push(argv[index + 1]);
  }
  return found;
}

export function argumentValue(argv, flag, fallback = null) {
  const found = argumentValues(argv, flag);
  if (found.length === 0) return fallback;
  return found[found.length - 1];
}

/** One list of names, however the caller chose to hand it over.
 *
 *  All three forms mean the same thing and none of them is discovery: in every case the SET is
 *  decided outside this process and this process is told. Repeatable `--package` matches the
 *  sibling runner. A file and standard input exist because this corpus has hundreds of packages
 *  and a caller should not have to build a ten-thousand character command line to ask a question
 *  about all of them; the difference between a flag and a pipe is transport, not authority.
 *
 *  Blank lines and `#` comments are dropped so a hand-kept list can say why a name is in it. */
const namesInText = (text) => text
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

export function packageNamesFrom(argv, readText = (p) => readFileSync(p, 'utf8'), readStdin = () => readFileSync(0, 'utf8')) {
  const listFile = argumentValue(argv, '--package-names-from');
  const all = [
    ...argumentValues(argv, '--package'),
    ...(listFile === null ? [] : namesInText(readText(listFile))),
    ...(argv.includes('--package-names-from-standard-input') ? namesInText(readStdin()) : []),
  ];
  if (all.length === 0) {
    throw new Error('NO_PACKAGES_NAMED: pass --package <name> (repeatable), --package-names-from <file>, or --package-names-from-standard-input');
  }
  return [...new Set(all)];
}

/** Read one document per named package, keeping the ones that would not parse.
 *
 *  A document that will not parse is NOT silently skipped. Skipping removes it from the
 *  denominator, and a corpus that shrinks quietly is how a report converges on clean while the
 *  thing it was watching gets worse. A package with no such document is a different case and is
 *  reported separately, because "not one of these" and "broken" are not the same answer. */
export function documentsForPackages({ packagesFolder, packageNames, documentName, readText = (p) => readFileSync(p, 'utf8') }) {
  const documents = [];
  const unreadable = [];
  const absent = [];

  // TWO BASES, because this corpus demonstrably uses two rooting conventions in the same field:
  // most addresses are relative to the package's own folder, and some are relative to the folder
  // ENCLOSING every package. Measured, not assumed: resolving against only the first reported 39
  // dead paths and every one of them was alive under the second convention or a suffix.
  const enclosing = path.dirname(packagesFolder);

  for (const name of packageNames) {
    const packageFolder = path.join(packagesFolder, name);
    const bases = [packageFolder, packagesFolder, enclosing];
    const source = path.join(packageFolder, documentName);
    let text;
    try {
      text = readText(source);
    } catch {
      absent.push(source);
      continue;
    }
    try {
      documents.push({ source, bases, document: JSON.parse(text) });
    } catch (error) {
      unreadable.push({ source, error: String(error?.message ?? error) });
    }
  }

  return { documents, unreadable, absent };
}

export function reportLines({ documents, unreadable, absent, unresolved, counts = {}, packagesFolder }) {
  const lines = [
    `documents read: ${documents.length}`,
    `documents absent: ${absent.length}`,
    `documents that would not parse: ${unreadable.length}`,
  ];
  for (const bad of unreadable) lines.push(`  UNREADABLE ${bad.source}: ${bad.error}`);
  // THE DENOMINATOR, and it goes ABOVE the failure count on purpose. The same reason this file
  // already gives for keeping an unparseable document in the count: a report that shrinks its own
  // corpus quietly converges on clean while the thing it watches gets worse. A failure count with
  // no attempt count cannot tell "nothing is wrong" from "the question was never asked".
  for (const [key, count] of Object.entries(counts)) {
    lines.push(`declarations found at ${key}: ${count}${count === 0 ? '  <-- NOTHING WAS EXAMINED AT THIS KEY' : ''}`);
  }
  lines.push(`declared paths that do not resolve: ${unresolved.length}`);
  for (const found of unresolved) {
    lines.push(`  DEAD ${path.relative(packagesFolder, found.source)} [${found.route.join(' > ')}] -> ${found.declared}`);
  }
  return lines;
}

export function runReport(argv) {
  const packagesFolder = argumentValue(argv, '--packages-folder');
  const documentName = argumentValue(argv, '--document-name', 'things-to-store-and-run.json');
  const keys = (argumentValue(argv, '--keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  // A key whose value is a LIST of addresses, one per entry, rather than a single address. Two
  // arguments because a list of strings means two different things in this corpus and its shape
  // does not say which: `checks` is many file addresses, while an interpreter projection's
  // `source_path` is ONE record address written as segments. Which meaning a key carries is a fact
  // about the reader, like `--bases` and `--suffixes`, so the caller owns it.
  const eachInKeys = (argumentValue(argv, '--each-in-keys') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  // `--suffixes` is a comma list where an EMPTY member means "exactly as written", so the default
  // is a bare comma-free empty string. A reader that appends an extension is a fact about that
  // reader, so the list belongs to the caller and no extension is spelled in this package.
  const suffixes = (argumentValue(argv, '--suffixes') ?? '').split(',').map((s) => s.trim());

  if (!packagesFolder) throw new Error('NO_VALUE_FOR:--packages-folder');
  if (keys.length + eachInKeys.length === 0) throw new Error('NO_VALUE_FOR:--keys or --each-in-keys');

  const packageNames = packageNamesFrom(argv);
  const { documents, unreadable, absent } = documentsForPackages({ packagesFolder, packageNames, documentName });
  const counts = declaredPathCountsByKey(documents, keys, eachInKeys);
  const unresolved = unresolvedPathsAcrossDocuments(documents, keys, suffixes, undefined, eachInKeys);

  return { lines: reportLines({ documents, unreadable, absent, unresolved, counts, packagesFolder }), unresolved, unreadable, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { lines } = runReport(process.argv);
  for (const line of lines) console.log(line);
}
