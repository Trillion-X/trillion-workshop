#!/usr/bin/env node
/**
 * Run every check a package DECLARES, and say loudly which ones could not be run.
 *
 * WHY THIS EXISTS. `bitfield-packages/package.json` `scripts` is a hardcoded
 * per-package list, each entry naming exact file paths and mixing five runners.
 * Adding a package means editing that object, so the set of tested packages is an
 * enumeration somebody maintains, and it drifted the way enumerations drift:
 * `reservation-tracker` and `content-production` had no entry at all, so nothing
 * ran their suites.
 *
 * It held 14 entries when this was written, three of which are now gone because
 * `email-client` and `service-connections` declare their own checks instead. An
 * earlier version of this comment said sixteen, counted by eye off a printed
 * object. A number stated inside a correct argument is the kind nobody
 * re-derives, so it is left out of the prose here on purpose: the count is a
 * `jq '.scripts | keys | length'` away and it changes every time a package moves.
 *
 * `packages/check-and-test-one-rust-crate` is the tombstone of this same idea,
 * `kind: package-retired`. Its NAME is why it could not absorb the need: "rust
 * crate" is the first instance welded into the identity, so when TypeScript and
 * Python arrived there was nothing for them to extend and the script list grew
 * instead. This one is named for the job, so the next language is a row in
 * RUNNERS.
 *
 * WHY DECLARED AND NOT DISCOVERED. The first draft walked the package folder for
 * anything test-shaped. That is a hand-rolled filesystem scanner, which this repo
 * owns elsewhere, and it was the worse design anyway: a walker cannot tell a
 * suite from a fixture, and an absence of checks looks identical to a package
 * that has none on purpose. A declaration makes "this package declares no checks"
 * a VISIBLE fact instead of an emptiness nobody notices.
 *
 * THE RULE THAT MATTERS, and the proposal originally had it backwards. A check
 * that could not be run is `no_runner`, and `no_runner` FAILS. The first draft
 * exited 0 on it, reasoning that a missing runner is not the package's fault.
 * That reasoning reproduces the exact defect this tool exists to end: absence
 * being survivable is what let untested suites accumulate while every report
 * looked clean. Somewhere without vitest, the lenient version prints green for
 * ever while every TypeScript suite rots. A caller who knowingly accepts a
 * missing runner passes `--tolerate-missing-runner`, at the call site, in view.
 *
 * THE SPLIT. This tool reports FACTS. The exit code encodes a POLICY. Facts are
 * identical everywhere; policy is per caller, so policy is flags.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reading names out of a folder tree belongs to the package that owns facts about local files, not
// to a second walk written here. See `checkFilesPresentInPackage` for what that owner already
// handles correctly and this file would have had to rediscover.
import { namesAndContentIdentitiesFromAFolderTree } from '../../local-files/read-data/names-and-content-identities-from-a-folder-tree.mjs';

/**
 * DATA, not dispatch. A new language is a row here and nothing else changes.
 *
 * `probe` is separate from `command` because "the check failed" and "the runner
 * is absent" are different facts. Collapsing them turns a missing runner into a
 * false red, or into a green nobody questions.
 *
 * `id` names the runner for reporting, and `command` names the program to spawn.
 * They were ONE field until 2026-09-05 and separating them is what fixed vitest.
 *
 * `workspaceEntry`, when present, is a path RELATIVE TO THE PACKAGE SET FOLDER
 * that is the runner itself, spawned as the first argument to `command`. A
 * runner installed into the workspace is not on PATH, and the previous row asked
 * PATH for a bare `vitest`, got nothing, and reported `no_runner` for every
 * TypeScript suite in the corpus. That read as "vitest cannot be run here",
 * which was recorded as a capability wall and is not one: the same suite runs
 * through the workspace entry. The runner was being looked for in the one place
 * a workspace install never puts it.
 *
 * A `workspaceEntry` row is available only when that file EXISTS, which is a
 * stronger and cheaper probe than spawning a `--version` that answers for the
 * interpreter rather than for the runner.
 */
export const CHECK_RUNNER_TABLE_KIND = 'check-runner-table';

/**
 * The table is THIS TOOL's DATA, so it is read from this package's own manifest
 * and not from whichever package set is being checked.
 *
 * The first attempt read it from the subject folder and every test failed at
 * once, which was the design telling the truth: a fixture set has no copy of this
 * tool's manifest and correctly should not need one. A set being checked does not
 * get to say how checks are run.
 */
const OWN_MANIFEST = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'things-to-store-and-run.json',
);

/**
 * The runner table is DATA and this file does not carry one.
 *
 * It used to be a const array here, under a docstring calling it "DATA, not
 * dispatch". That was false in the way that matters: adding a language still
 * meant editing this file, which is the enumeration this package exists to end,
 * moved one file over. The owner caught the identical shape in engine code the same
 * day, where a resolver named one ecosystem inside a layer that is supposed to
 * know none.
 *
 * There is NO built-in fallback table. A fallback would mean the tool keeps
 * working while its DATA is missing, which is how a stale or absent declaration
 * stops being visible. Missing DATA fails loudly and says where to put it.
 */
export function readRunnerTable(manifestPath = OWN_MANIFEST, readFile = fs.readFileSync) {
  const manifest = manifestPath;
  let parsed;
  try {
    parsed = JSON.parse(readFile(manifest, 'utf8'));
  } catch (error) {
    throw new Error(
      `the runner table is DATA and could not be read from ${manifest}: ${error?.message ?? error}`,
    );
  }
  const record = (parsed?.things ?? [])
    .map((thing) => thing?.payload)
    .find((payload) => payload?.kind === CHECK_RUNNER_TABLE_KIND);
  const rows = Array.isArray(record?.runners) ? record.runners : [];
  if (rows.length === 0) {
    throw new Error(
      `no ${CHECK_RUNNER_TABLE_KIND} record with a non-empty runners list in ${manifest}. `
      + 'Adding a language is a row there, never a change to this file.',
    );
  }
  return rows.map((row) => ({
    ...row,
    matches: new RegExp(row.matches),
    selectedByContent: row.selected_by_content ? new RegExp(row.selected_by_content, 'm') : null,
  }));
}

export const CHECKS_DESCRIPTOR_KIND = 'package-checks-descriptor';

/** The one file every package has. Both the per-package read and the set walk resolve it here. */
export const PACKAGE_MANIFEST_FILE = 'things-to-store-and-run.json';

/**
 * Where subjects sit under the folder a caller names. The literal `'packages'` was written into
 * four separate `path.join` calls, one of which is the path-escape boundary in
 * `resolveInsidePackage`, so a repository laying its subjects out any other way was not merely
 * unsupported: it was unreachable, and it reported `not_found`, which is the same answer this tool
 * gives for a package name nobody has. A layout is an INSTANCE. The mechanism is "a manifest
 * declares its checks", and that is true of any folder holding one.
 *
 * A suite nobody runs is worse than no suite, since it reads as coverage while providing none.
 * What that cost in the repository this unblocked is measured in
 * notes/knowledge/testing-and-verification/js-suites-outside-bitfield-packages-run-through-packages-subfolder.md
 * rather than here: the first version of this comment carried a count, and it was wrong before the
 * session that wrote it had ended.
 *
 * It is a trailing argument rather than a fallback: exactly one path is tried, the caller says
 * which, and a wrong answer stays a loud `not_found` instead of quietly finding a second place.
 *
 * WHY THIS IS NOT SIMPLY DELETED, since the smaller change is to make `--package-set-folder` MEAN
 * the folder that holds packages and drop this concept entirely. That folder is also the workspace
 * root: `workspaceEntryPath` resolves a runner's `node_modules/...` entry against it, and
 * `node_modules` sits beside `packages/`, not inside it. Redefining the flag would therefore split
 * one argument into two rather than removing one, so the deletion adds a concept and is refused.
 */
export const PACKAGES_SUBFOLDER = 'packages';
/** How many failed assertions a file's detail shows before it says what it omitted. */
const SHOWN_ASSERTION_LIMIT = 4;
/** Lines kept from each END of a failing check's output. See `failureDetail`. */
const KEPT_DETAIL_LINES = 12;

/**
 * What a failing check's output gets reduced to.
 *
 * This was `output.trim().split('\n').slice(-12)`, a pure TAIL window, and the
 * tail is the wrong end. Every mainstream reporter puts the REASON at the head of
 * a failure block and the MACHINERY at the tail: node's test runner ends with the
 * stack and then an error-properties block (`generatedMessage`, `code`, `actual`,
 * `expected`, `operator`, `diff`, `}`) that is itself about twelve lines. So the
 * window was filled exactly by the boilerplate and the assertion message, the one
 * line a human wrote to explain the failure, fell off the top EVERY TIME.
 *
 * Measured 2026-09-10 while debugging a check in this very repository: the report
 * said `null !== 0` and nothing else, four runs in a row, while the message
 * naming the signal and the failing source line sat just above the cut. Widening
 * the window would have been a bigger arbitrary number answering an arbitrary
 * number; keeping BOTH ENDS answers the shape of the output instead, and the
 * elision line says how much is missing so a truncated detail can never be
 * mistaken for the whole story.
 */
export function failureDetail(output) {
  const lines = output.trim().split('\n');
  if (lines.length <= KEPT_DETAIL_LINES * 2) return lines.join('\n');
  const dropped = lines.length - KEPT_DETAIL_LINES * 2;
  return [
    ...lines.slice(0, KEPT_DETAIL_LINES),
    `... ${dropped} line${dropped === 1 ? '' : 's'} omitted from the middle ...`,
    ...lines.slice(-KEPT_DETAIL_LINES),
  ].join('\n');
}
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Count an outcome, creating its slot on first sight.
 *
 * This was `totals[outcome] += 1` against a bag with nine keys written by hand. An outcome the bag
 * did not anticipate produced `undefined + 1`, which is `NaN`, and `NaN > 0` is false, so a new way
 * of not getting an answer would have been counted into a slot that reads as zero and decided
 * nothing. The ways a question goes unanswered are an OPEN set owned by the world (a runner that
 * vanished, a timeout, a manifest nobody can parse, a permission that changed), so the counter has
 * to accept a member nobody enumerated, and the policy below has to fail on it by default.
 */
function countOutcome(totals, outcome) {
  totals[outcome] = (totals[outcome] ?? 0) + 1;
}

/**
 * The outcomes that are NOT findings, which is the only list this file is allowed to enumerate.
 *
 * ⛔ THIS USED TO BE `ALWAYS_FATAL`, A LIST OF WHAT FAILS, AND THAT IS AN ALLOW-LIST OF FAILURES
 * WEARING A DENY-LIST'S NAME. It enumerated six outcomes while ten existed, so `not_found` and
 * `manifest_unreadable` exited 0. Measured 2026-09-09 with a control: `--package
 * zzz-no-such-package-exists` exited 0 while a genuinely failing package exited 1, so a typo in a
 * package name was indistinguishable from a clean run, and so was asking about a package somebody
 * had deleted.
 *
 * Inverting it is the fix rather than adding the two missing strings, because the list that has to
 * stay complete is now the list of things that are FINE, and that set is closed: a check either
 * answered and passed, or it did not, and everything in the second group deserves a human. An
 * outcome invented next month is fatal without anyone editing this line, which is the property the
 * old shape could not have.
 */
const NOT_A_FINDING = new Set(['passed']);

/**
 * Every package the set folder holds, by name.
 *
 * A caller had to enumerate `--package` to ask anything. That is right for the run path, where you
 * run what you chose, and it is the wrong shape for the adoption path, where the only useful
 * question is about the WHOLE set. Nobody had ever asked it: `--report-undeclared-check-files`
 * shipped fully wired and effectively unrunnable across the corpus, because naming three hundred
 * packages by hand is not something anyone does. A question that cannot be asked reads exactly like
 * a question with a clean answer.
 *
 * The walk is NOT hand-rolled, for the same reason `checkFilesPresentInPackage` does not hand-roll
 * one. `skipEntry` prunes to exactly the manifests: any directory below the package level, and any
 * file that is not the manifest. So a package is identified by the file every package has, read
 * from the same name `declaredChecks` reads, and a folder that is not a package cannot enter here
 * and then come back `not_found` from the next step.
 */
export async function everyPackageInTheSet(packageSetFolder, packagesSubfolder = PACKAGES_SUBFOLDER) {
  const packagesRoot = path.join(packageSetFolder, packagesSubfolder);
  if (!fs.existsSync(packagesRoot)) return [];
  const names = [];
  const tree = namesAndContentIdentitiesFromAFolderTree(packagesRoot, {
    skipEntry: ({ name, relativePath, isDirectory }) =>
      isDirectory
        ? name.startsWith('.') || relativePath.includes(path.sep)
        : name !== PACKAGE_MANIFEST_FILE,
  });
  for await (const entry of tree) names.push(path.dirname(entry.name));
  return names.sort();
}

export function parseArguments(argv) {
  const parsed = {
    packageSetFolder: '',
    packagesSubfolder: PACKAGES_SUBFOLDER,
    subfolderWasNamed: false,
    packages: [],
    everyPackage: false,
    listOnly: false,
    tolerateMissingRunner: false,
    requireChecks: false,
    reportUndeclaredCheckFiles: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--package-set-folder') parsed.packageSetFolder = argv[index += 1] ?? '';
    // ⛔ REPEATING THIS FLAG SILENTLY KEPT ONLY THE LAST VALUE, which is the exact failure this flag
    // was added to end, one level up. Asked about a repository that lays packages out under two
    // folders, the run answered a clean and internally consistent report about a SUBSET of itself:
    // totals reconciled, `no_runner` was zero, and thirty-two suites that have never run were not
    // mentioned, because nothing had looked at them. A silently dropped argument and a genuinely
    // empty folder produce the identical report.
    //
    // It REFUSES rather than accumulating, and that is the delete step rather than a smaller
    // feature. One invocation answers about one folder; a caller wanting several runs it several
    // times, which is what the commit gate already does, so merging reports here would be a second
    // way to do something that already works. What was missing was never the merge, it was the
    // refusal to answer a question that had been quietly narrowed.
    else if (flag === '--packages-subfolder') {
      const named = argv[index += 1] ?? '';
      if (parsed.subfolderWasNamed && named !== parsed.packagesSubfolder) {
        throw new Error(
          `--packages-subfolder was given twice, as "${parsed.packagesSubfolder}" and "${named}". ` +
          'One run answers about one folder. Run it once per folder, or the report describes a ' +
          'subset of the repository while looking complete.',
        );
      }
      parsed.packagesSubfolder = named;
      parsed.subfolderWasNamed = true;
    }
    else if (flag === '--package') parsed.packages.push(argv[index += 1] ?? '');
    else if (flag === '--every-package-in-the-set') parsed.everyPackage = true;
    else if (flag === '--list') parsed.listOnly = true;
    else if (flag === '--tolerate-missing-runner') parsed.tolerateMissingRunner = true;
    else if (flag === '--require-checks') parsed.requireChecks = true;
    else if (flag === '--report-undeclared-check-files') parsed.reportUndeclaredCheckFiles = true;
    else if (flag === '--timeout-ms') parsed.timeoutMs = Number(argv[index += 1] ?? DEFAULT_TIMEOUT_MS);
  }
  return parsed;
}

/**
 * One known file read by exact path. The declaration lives in the package's own
 * manifest beside everything else it declares, so there is no second place to
 * keep in step.
 */
export function declaredChecks(packageSetFolder, packageName, packagesSubfolder = PACKAGES_SUBFOLDER) {
  const manifestPath = path.join(packageSetFolder, packagesSubfolder, packageName, PACKAGE_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return { exists: false, checks: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { exists: true, malformed: String(error?.message ?? error), checks: [] };
  }
  const things = Array.isArray(manifest?.things) ? manifest.things : [];
  const descriptor = things
    .map((thing) => thing?.payload)
    .find((payload) => payload?.kind === CHECKS_DESCRIPTOR_KIND);
  const declared = Array.isArray(descriptor?.checks) ? descriptor.checks.filter((entry) => typeof entry === 'string') : [];
  return { exists: true, declared: Boolean(descriptor), checks: [...new Set(declared)] };
}

/**
 * Which runner runs this file.
 *
 * A NAME is weak evidence and CONTENT is strong evidence, so content wins when it is available.
 * The reason is not style: a test file that imports its framework has DECLARED its runner, and
 * choosing from the name overrules that declaration with a guess. A file whose name matches one
 * runner's convention while its imports name a different runner is not ambiguous; a selector
 * reading only the name is looking at the half of the file that cannot say. Handed to the wrong
 * runner, such a file dies inside the other runner's collector with no frame in the package, and
 * the report says FAILED, which is indistinguishable from a suite that has a bug.
 *
 * `readTextOrNull` is optional because two of the three call sites have only a name. The name rule
 * stays as the fallback and is not deletable: a python check can be a bare script of asserts that
 * imports nothing, so for some files the name is the only evidence there is.
 *
 * Ambiguity is refused rather than resolved. If two runners both claim the content, the DATA is
 * wrong and picking the first would make which one wins depend on row order.
 */
export function runnerFor(file, runners = readRunnerTable(), readTextOrNull = null) {
  const text = typeof readTextOrNull === 'function' ? readTextOrNull(file) : null;
  if (typeof text === 'string') {
    const claimed = runners.filter((runner) => runner.selectedByContent?.test(text));
    if (claimed.length > 1) {
      throw new Error(
        `${file} matches selected_by_content for ${claimed.map((runner) => runner.id).join(' and ')}. `
        + 'Two runners claiming one file is a defect in the check-runner-table DATA, not a tie to break here.',
      );
    }
    if (claimed.length === 1) return claimed[0];
  }
  return runners.find((runner) => runner.matches.test(file));
}

/** Folders a check-file search must not descend into. DATA, beside the runners it belongs with. */
export function readFoldersThatAreNotSource(manifestPath = OWN_MANIFEST, readFile = fs.readFileSync) {
  const parsed = JSON.parse(readFile(manifestPath, 'utf8'));
  const record = (parsed?.things ?? [])
    .map((thing) => thing?.payload)
    .find((payload) => payload?.kind === CHECK_RUNNER_TABLE_KIND);
  const rows = record?.folders_that_are_not_source;
  return new Set(Array.isArray(rows) ? rows.filter((row) => typeof row === 'string') : []);
}

/**
 * Every file under the package that some runner in the table would run.
 *
 * This exists so a declaration cannot silently OMIT. The declared list still decides what RUNS,
 * which is right: it lets a package stand behind exactly what it has finished, and it keeps a
 * peer's half-written file from being force-run on a shared branch. But a list is also a closed
 * set, and before this the only signal for a check file nobody declared was that it never
 * appeared, which reads identically to the package having no such file. `local-files` sat with
 * four committed suites and no declaration, and the report called that "declaring nothing" rather
 * than "four files nobody is running".
 *
 * The walk is NOT hand-rolled here. Reading names out of a folder tree is owned by
 * `local-files/read-data/names-and-content-identities-from-a-folder-tree.mjs`, which already
 * handles the parts a fresh walk gets wrong: an explicit stack so depth is not bounded by the call
 * stack, sorted order so a resumed walk addresses the same row, symlinks neither followed nor
 * hashed, and an unreadable directory reported rather than ending the walk. Its `skipEntry` hook is
 * where the DATA above lands.
 *
 * Matching uses the SAME runner table as execution, so a new language stays one DATA row and
 * cannot arrive in one half of this owner and not the other.
 */
export async function checkFilesPresentInPackage(
  packageSetFolder,
  packageName,
  runners = readRunnerTable(),
  notSource = readFoldersThatAreNotSource(),
  packagesSubfolder = PACKAGES_SUBFOLDER,
) {
  const packageRoot = path.join(packageSetFolder, packagesSubfolder, packageName);
  if (!fs.existsSync(packageRoot)) return [];
  const found = [];
  const tree = namesAndContentIdentitiesFromAFolderTree(packageRoot, {
    // A leading dot means "hidden from tooling" everywhere, so it needs no row of its own.
    skipEntry: ({ name, isDirectory }) => isDirectory && (name.startsWith('.') || notSource.has(name)),
  });
  for await (const entry of tree) {
    if (runners.some((runner) => runner.matches.test(entry.name))) found.push(entry.name);
  }
  return found.sort();
}

/**
 * A manifest is data many hands edit, so a declared string is untrusted input.
 * Without this, `"../../../../somewhere/else"` in a manifest becomes command
 * execution. Confinement is tested on the RESOLVED real path, so `..` segments
 * and symlinks are both covered by one check.
 */
export function resolveInsidePackage(
  packageSetFolder,
  packageName,
  declaredPath,
  packagesSubfolder = PACKAGES_SUBFOLDER,
) {
  // Resolve the ROOT first, then build the candidate from the resolved root.
  // Doing it the other way compares a literal candidate against a realpath'd
  // root, and on any machine where a parent is a symlink (macOS `/var` points at
  // `/private/var`) a merely MISSING file inside the package is reported as
  // escaping it. That is a wrong and frightening diagnostic for a boring typo,
  // and this package's own suite caught it on the first run.
  const declaredRoot = path.resolve(packageSetFolder, packagesSubfolder, packageName);
  const packageRoot = fs.existsSync(declaredRoot) ? fs.realpathSync(declaredRoot) : declaredRoot;
  const candidate = path.resolve(packageRoot, declaredPath);
  const real = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  const inside = real === packageRoot || real.startsWith(`${packageRoot}${path.sep}`);
  return { absolute: real, inside };
}

/**
 * Every folder from `from` up to and including `to`, nearest first, empty when `from` is not
 * under `to`. Separated from the lookup below so the walk can be tested without a filesystem.
 */
export function foldersFromHereUpTo(from, to) {
  const stopAt = path.resolve(to);
  const chain = [];
  let at = path.resolve(from);
  while (at !== stopAt && at !== path.dirname(at)) {
    chain.push(at);
    at = path.dirname(at);
  }
  return at === stopAt ? [...chain, stopAt] : [];
}

/**
 * Where an installed runner lives, or null for a PATH runner.
 *
 * ⛔ THIS RESOLVED ONLY AT THE SET ROOT, which is one repository's layout adopted as the
 * definition, the same shape as the `packages` literal this file already had removed once. It is
 * true of a workspace, where `node_modules` sits beside the packages folder and every package
 * shares it. It is false of a repository where a package carries its own dependencies, and there
 * the consequence was silent in the worst direction: the runner answered `no_runner`, "has never
 * run in this environment", about suites whose runner was installed the whole time one folder
 * down. A package nobody can test and a package whose tooling was looked for in the wrong place
 * read identically.
 *
 * So it searches from the package UP to the set root and takes the first entry that exists, which
 * is how Node resolves a dependency anyway. The workspace case is then not a second rule, it is
 * this search finding the entry on its last step. When nothing exists anywhere on the path it
 * returns the set-root candidate, so the "not installed at X" message still names the place a
 * reader would put it.
 */
export function workspaceEntryPath(runner, packageSetFolder, startFrom = packageSetFolder) {
  if (!runner.workspaceEntry) return null;
  const searched = foldersFromHereUpTo(startFrom, packageSetFolder);
  const found = searched
    .map((folder) => path.resolve(folder, runner.workspaceEntry))
    .find((candidate) => fs.existsSync(candidate));
  return found ?? path.resolve(packageSetFolder, runner.workspaceEntry);
}

/**
 * Read a batch report and say, per declared file, what it reported.
 *
 * Kept apart from spawning so it can be tested with a report and no process.
 * The spec is DATA: `list`, `file_key`, `status_key` and `passed_value` are
 * named by the runner row, so a runner whose report calls its array something
 * else is a row change and not a change here.
 *
 * `unreported` is the whole reason this function is separate. A file we handed
 * to the runner that the report never names has no honest outcome: it is not
 * passed, it did not fail, and nothing killed it. Answering it with any of
 * those would be a lie, and re-running it alone to find out would be the
 * fallback-hides-the-error shape this tool exists to refuse.
 */
export function readBatchReport(spec, reportText, entries, realPathOf = (value) => {
  try { return fs.realpathSync(value); } catch { return value; }
}) {
  const parsed = parseReportText(reportText);
  if (!parsed.ok) return { ok: false, why: parsed.why };
  const list = parsed.value?.[spec.list];
  if (!Array.isArray(list)) {
    return {
      ok: false,
      why: `the report has no array at "${spec.list}"; its top-level keys are ${JSON.stringify(Object.keys(parsed.value ?? {}))}`,
    };
  }
  const byPath = new Map();
  for (const item of list) {
    const named = item?.[spec.file_key];
    if (typeof named !== 'string') continue;
    byPath.set(realPathOf(named), item);
  }
  const results = new Map();
  for (const entry of entries) {
    const key = realPathOf(entry.absolute);
    if (!byPath.has(key)) {
      results.set(entry.file, {
        outcome: 'declared_but_unreported',
        detail: `the batch ran and its report never named this file. It named ${list.length}: `
          + `${[...byPath.keys()].slice(0, 4).join(', ')}${byPath.size > 4 ? ', ...' : ''}`,
      });
      continue;
    }
    const item = byPath.get(key);
    const status = item?.[spec.status_key];
    if (status === spec.passed_value) { results.set(entry.file, { outcome: 'passed' }); continue; }
    // The row may name where THIS reporter puts a per-file explanation. Without
    // one the only honest detail is the status, because the shared stream IS the
    // report and attaching it would hand every failure the same 30 KB of JSON.
    const explained = spec.detail_key ? item?.[spec.detail_key] : null;
    const reason = typeof explained === 'string' && explained.trim()
      ? explained.trim()
      : failedAssertions(spec.failures, item);
    results.set(entry.file, {
      outcome: 'failed',
      detail: reason || `the batch report gives this file status ${JSON.stringify(status)} and names no reason`,
    });
  }
  return { ok: true, results };
}

/**
 * The failed assertions inside one file's report entry, as evidence.
 *
 * A per-file `detail_key` only covers the failures a reporter attributes to the
 * FILE, which for this vitest is a collection error such as an unresolved import.
 * A suite that fails on assertions leaves that key empty and puts the reasons one
 * level down, per test. Without this the report said "names no reason" for the
 * most ordinary failure there is, which is the empty-detail signature this tool
 * added the `killed` outcome to stop producing.
 *
 * Every key is named by the row, so a reporter that nests its failures differently
 * is DATA rather than a change here, and a row that names no `failures` block
 * simply gets nothing extra.
 */
function failedAssertions(spec, item) {
  if (!spec || !item) return '';
  const list = item[spec.list];
  if (!Array.isArray(list)) return '';
  const lines = [];
  for (const assertion of list) {
    if (!assertion || assertion[spec.status_key] !== spec.failed_value) continue;
    const title = assertion[spec.title_key];
    const messages = assertion[spec.messages_key];
    const first = Array.isArray(messages) ? messages.find((message) => typeof message === 'string') : null;
    // The stack is the runner's, not the package's, so the first lines carry the
    // assertion and everything after is frames inside vitest.
    const trimmed = typeof first === 'string' ? first.split('\n').slice(0, 3).join('\n') : '';
    lines.push([title, trimmed].filter(Boolean).join('\n').trim());
  }
  const shown = lines.filter(Boolean);
  if (shown.length === 0) return '';
  // SAY WHAT IS OMITTED. A quiet cap makes a failure count look smaller than it is,
  // which is the same defect as a report that accuses one file for a whole batch:
  // this cap hid two of six failures the first time it ran, and the two it hid were
  // the ones that would have shown the real cause.
  const head = shown.slice(0, SHOWN_ASSERTION_LIMIT);
  const omitted = shown.length - head.length;
  return omitted > 0
    ? `${shown.length} assertions failed in this file, showing the first ${head.length}:\n\n${head.join('\n\n')}`
    : head.join('\n\n');
}

/**
 * A reporter writing JSON to stdout shares that stream with anything else the
 * process prints, so a warning line ahead of the payload is ordinary rather
 * than exceptional. Parsing the whole stream first and falling back to the
 * outermost braces recovers that case without inventing meaning: if the slice
 * is not valid JSON either, this still fails and says so, which is the
 * difference between recovering a readable report and hiding an unreadable one.
 */
function parseReportText(reportText) {
  const text = String(reportText ?? '');
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* fall through */ }
  const opened = text.indexOf('{');
  const closed = text.lastIndexOf('}');
  if (opened >= 0 && closed > opened) {
    try { return { ok: true, value: JSON.parse(text.slice(opened, closed + 1)) }; } catch { /* fall through */ }
  }
  return {
    ok: false,
    why: text.trim().length === 0
      ? 'the batch produced no report at all on the stream the row names'
      : `the batch report is not JSON. It begins ${JSON.stringify(text.trim().slice(0, 120))}`,
  };
}

export function makeCheckRunner({
  spawn = spawnSync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  packagesSubfolder = PACKAGES_SUBFOLDER,
} = {}) {
  const probeResults = new Map();
  const programFor = (value) => (value === '$process.execPath' ? process.execPath : value);
  // Keyed by `id` rather than `command`, because two rows now share one command
  // and a probe answering for `node` must not answer for vitest.
  const runnerIsAvailable = (runner, packageSetFolder, startFrom) => {
    const entry = workspaceEntryPath(runner, packageSetFolder, startFrom);
    if (entry && !fs.existsSync(entry)) return false;
    // Keyed by id AND resolved entry, not id alone. Once a runner can be installed per package,
    // one package's absent vitest would otherwise answer for another package's present one, and
    // the cached answer would be whichever package was walked first.
    const key = `${runner.id}\u0000${entry ?? ''}`;
    if (probeResults.has(key)) return probeResults.get(key);
    const [command, ...args] = runner.probe;
    const available = spawn(programFor(command), args, { encoding: 'utf8' })?.status === 0;
    probeResults.set(key, available);
    return available;
  };

  /**
   * Everything a batch cannot answer, decided per file BEFORE any process runs.
   *
   * A batch report can only speak about files the runner was handed, so
   * "declared outside the package", "no runner matches this name", "the runner
   * is absent here" and "the file does not exist" must all be settled first.
   * Handing a missing path to a batch would turn a precise fact into whatever
   * that runner does with a bad argument.
   *
   * Returns either a finished result or the entry to run.
   */
  const classify = (declaredPath, packageSetFolder, packageName, runners) => {
    const { absolute, inside } = resolveInsidePackage(
      packageSetFolder,
      packageName,
      declaredPath,
      packagesSubfolder,
    );
    // Resolved BEFORE the runner is chosen, because the strongest evidence for which runner a file
    // needs is inside the file, and reading it needs the path. Only a file that resolved inside the
    // package and exists is read; everything else falls back to the name, which is what the later
    // branches report on anyway.
    const readIfReadable = inside && fs.existsSync(absolute)
      ? () => { try { return fs.readFileSync(absolute, 'utf8'); } catch { return null; } }
      : null;
    const runner = runnerFor(declaredPath, runners, readIfReadable);
    if (!runner) {
      return {
        result: {
          file: declaredPath,
          outcome: 'no_runner',
          detail: 'no row in the check-runner-table DATA matches this filename or its content, so adding support is a row there',
        },
      };
    }
    if (!inside) {
      return {
        result: {
          file: declaredPath,
          runner: runner.id,
          outcome: 'declared_outside_package',
          detail: `resolves to ${absolute}, which is outside this package`,
        },
      };
    }
    const packageRoot = path.resolve(packageSetFolder, packagesSubfolder, packageName);
    const entry = workspaceEntryPath(runner, packageSetFolder, packageRoot);
    if (!runnerIsAvailable(runner, packageSetFolder, packageRoot)) {
      return {
        result: {
          file: declaredPath,
          runner: runner.id,
          outcome: 'no_runner',
          detail: entry
            ? `${runner.id} is not installed at ${entry}, so this check has never run in this environment`
            : `${runner.id} is not available here, so this check has never run in this environment`,
        },
      };
    }
    if (!fs.existsSync(absolute)) {
      return { result: { file: declaredPath, runner: runner.id, outcome: 'declared_but_missing' } };
    }
    return { runner, entry, runnable: { file: declaredPath, absolute } };
  };

  /**
   * ONE runner boot for every batchable file in a package.
   *
   * The per-file path spawns a full runner per check, which is what made a
   * vitest-heavy package boot vitest 27 times, take ten minutes, and get one of
   * those processes killed by the OS. Batching removes the cause rather than
   * tolerating the symptom.
   *
   * Three things a batch redefines, each handled here rather than left implicit:
   * the timeout now covers a SET, so the detail says how many; a kill can no
   * longer be attributed to one file, so every file in the set is reported
   * killed, which is true of all of them; and a per-file detail has to come from
   * the report, so the shared trailing output is attached to each failure rather
   * than dropped, because a failure without evidence is the exact signature this
   * tool learned to distrust.
   */
  const runBatch = (runner, entry, entries, packageSetFolder) => {
    const spec = runner.batch.results;
    const result = spawn(
      programFor(runner.command),
      [
        ...(entry ? [entry] : []),
        ...runner.leadingArgs,
        ...(runner.batch.args ?? []),
        ...entries.map((item) => item.absolute),
      ],
      { cwd: packageSetFolder, encoding: 'utf8', timeout: timeoutMs },
    );
    const everyFile = (outcome, detail) => entries.map((item) => ({
      file: item.file, runner: runner.id, outcome, ...(detail ? { detail } : {}),
    }));
    if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      return everyFile('timed_out', `no result within ${timeoutMs}ms for a batch of ${entries.length} files`);
    }
    if (result.status === null && result.signal) {
      return everyFile(
        'killed',
        `the ${runner.id} batch of ${entries.length} files was killed by ${result.signal} before it could report`,
      );
    }
    if (spec?.in !== 'stdout_json') {
      return everyFile(
        'declared_but_unreported',
        `the runner row asks for results from ${JSON.stringify(spec?.in)}, which nothing here reads`,
      );
    }
    const read = readBatchReport(spec, result.stdout, entries);
    if (!read.ok) {
      // The only case where the raw stream is evidence rather than noise: the
      // report could not be read, so what the process printed is all there is.
      const trailing = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
      return everyFile('declared_but_unreported', `${read.why}\n${trailing}`.trim());
    }
    return entries.map((item) => {
      const found = read.results.get(item.file);
      return {
        file: item.file,
        runner: runner.id,
        outcome: found.outcome,
        ...(found.detail ? { detail: found.detail } : {}),
      };
    });
  };

  const runOne = (declaredPath, absolute, runner, entry, packageSetFolder) => {
    // Absolute path on purpose: a relative one is refused by the run guard with a
    // message about owner-owned code, which reads like a capability wall and is a
    // path-form complaint.
    const result = spawn(programFor(runner.command), [...(entry ? [entry] : []), ...runner.leadingArgs, absolute], {
      cwd: packageSetFolder,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      return { file: declaredPath, runner: runner.id, outcome: 'timed_out', detail: `no result within ${timeoutMs}ms` };
    }
    // A KILLED PROCESS DID NOT FAIL, IT NEVER FINISHED, and calling it `failed`
    // blames the code under test for something the machine did.
    //
    // Measured on 2026-09-05 rather than imagined: `public-sales-page` declares
    // 34 checks, 27 of them vitest, and four consecutive runs returned 34/0,
    // 32/2, 33/1 and 33/1 with a DIFFERENT file failing each time and an EMPTY
    // detail every time. A different file each run is not a defect in any of
    // them, and an empty detail means the process produced no stdout, no stderr
    // and no assertion, which no failing test does. Each check is a separate
    // full vitest boot, so 27 of them run back to back, and the reason
    // `status === null` with a signal was invisible is that this branch reported
    // it as `failed` with the empty output attached.
    //
    // The outcome is still fatal, because a check that did not complete is not a
    // pass. What changes is that the report now names the machine instead of
    // accusing the file, which is the same distinction `no_runner` exists for.
    if (result.status === null && result.signal) {
      return {
        file: declaredPath,
        runner: runner.id,
        outcome: 'killed',
        detail: `the ${runner.id} process was killed by ${result.signal} before it could report, so this check did not run`,
      };
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return {
      file: declaredPath,
      runner: runner.id,
      outcome: result.status === 0 ? 'passed' : 'failed',
      ...(result.status === 0 ? {} : { detail: failureDetail(output) }),
    };
  };

  /**
   * One package's whole declared list, in declared order.
   *
   * This runs the list rather than one file because batching is a property of
   * the SET: you cannot decide to boot a runner once while looking at a single
   * check. Results are collected into a map and emitted in declared order, so a
   * reader diffing two runs sees the same rows in the same places whether a
   * runner batches or not.
   */
  return function runDeclaredChecks(declaredPaths, packageSetFolder, packageName, runners) {
    const finished = new Map();
    const batches = new Map();
    for (const declaredPath of declaredPaths) {
      const decided = classify(declaredPath, packageSetFolder, packageName, runners);
      if (decided.result) { finished.set(declaredPath, decided.result); continue; }
      const { runner, entry, runnable } = decided;
      if (!runner.batch) {
        finished.set(declaredPath, runOne(declaredPath, runnable.absolute, runner, entry, packageSetFolder));
        continue;
      }
      if (!batches.has(runner.id)) batches.set(runner.id, { runner, entry, entries: [] });
      batches.get(runner.id).entries.push(runnable);
    }
    for (const { runner, entry, entries } of batches.values()) {
      for (const result of runBatch(runner, entry, entries, packageSetFolder)) finished.set(result.file, result);
    }
    return declaredPaths.map((declaredPath) => finished.get(declaredPath));
  };
}

export function buildReport(
  options,
  runDeclaredChecks = makeCheckRunner({
    timeoutMs: options.timeoutMs,
    packagesSubfolder: options.packagesSubfolder,
  }),
  runners = readRunnerTable(),
) {
  const report = {
    packages: [],
    totals: {
      passed: 0,
      failed: 0,
      no_runner: 0,
      declared_but_missing: 0,
      declared_outside_package: 0,
      timed_out: 0,
      killed: 0,
      declared_but_unreported: 0,
      packages_declaring_nothing: 0,
    },
  };

  for (const packageName of options.packages) {
    const declaration = declaredChecks(
      options.packageSetFolder,
      packageName,
      options.packagesSubfolder,
    );
    // COUNTED, not just recorded. These two used to be pushed into `packages` and into no total,
    // and `exitCodeFor` only ever sees totals, so asking about a package that does not exist was
    // structurally invisible to the exit code and the run went green. Measured 2026-09-09: a
    // nonsense `--package` name exited 0 while a genuinely failing package exited 1, so a typo in
    // a package name read exactly like success.
    if (!declaration.exists) {
      countOutcome(report.totals, 'not_found');
      report.packages.push({ package: packageName, outcome: 'not_found' });
      continue;
    }
    if (declaration.malformed) {
      countOutcome(report.totals, 'manifest_unreadable');
      report.packages.push({ package: packageName, outcome: 'manifest_unreadable', detail: declaration.malformed });
      continue;
    }
    if (!declaration.declared || declaration.checks.length === 0) {
      report.totals.packages_declaring_nothing += 1;
      report.packages.push({
        package: packageName,
        checks: [],
        // The note NAMES THE FLAG that answers the obvious next question, because the answer exists
        // and nobody was reaching it. `--report-undeclared-check-files` has been here the whole
        // time and stays opt-in for the documented reason above `undeclaredCheckFilesReport`: it is
        // asynchronous and answers a different question. What it should not be is a secret.
        //
        // A MEASUREMENT USED TO SIT HERE, saying how many packages declare anything and how many
        // check files are undeclared. Both were wrong within a day of being written, because the
        // only thing that can change them is a package declaring a suite, and a package declaring a
        // suite cannot reach a comment in this file. That is the whole argument against a count in
        // code: it is a claim with no way to be corrected by its own subject. The invariant needs
        // no number, and the corpus reading with its date and denominator lives in
        // `notes/knowledge/dev-tooling/what-actually-runs-when-you-run-the-tests.md`,
        // which a fresh run corrects in place.
        note: `no ${CHECKS_DESCRIPTOR_KIND} with a non-empty checks list, so nothing here is verified.`
          + ' Run --report-undeclared-check-files to see which check files this package has and'
          + ' nobody declared',
      });
      continue;
    }
    if (options.listOnly) {
      report.packages.push({
        package: packageName,
        checks: declaration.checks.map((file) => ({ file, runner: runnerFor(file, runners)?.id ?? null })),
      });
      continue;
    }
    const checks = runDeclaredChecks(declaration.checks, options.packageSetFolder, packageName, runners);
    for (const check of checks) countOutcome(report.totals, check.outcome);
    report.packages.push({ package: packageName, checks });
  }

  return report;
}

/**
 * Per package: which check files are present, which of those nobody declared, and which declared
 * names match no file on disk.
 *
 * Kept apart from `buildReport` on purpose. That answers "did what is declared pass", and this
 * answers "what is not being verified at all". Folding the second into the first would make a
 * package carrying one undeclared file indistinguishable from one carrying a failing test, and it
 * would turn a synchronous run into an asynchronous one for a question nobody asked during a run.
 */
export async function undeclaredCheckFilesReport(
  packageSetFolder,
  packageNames,
  packagesSubfolder = PACKAGES_SUBFOLDER,
) {
  const runners = readRunnerTable();
  const notSource = readFoldersThatAreNotSource();
  const packages = [];
  let undeclared = 0;
  let declaredWithNoFile = 0;
  for (const packageName of packageNames) {
    const declaration = declaredChecks(packageSetFolder, packageName, packagesSubfolder);
    if (!declaration.exists) {
      packages.push({ package: packageName, outcome: 'not_found' });
      continue;
    }
    const present = await checkFilesPresentInPackage(
      packageSetFolder,
      packageName,
      runners,
      notSource,
      packagesSubfolder,
    );
    const declared = new Set(declaration.checks);
    const presentSet = new Set(present);
    const notDeclared = present.filter((file) => !declared.has(file));
    const noFile = declaration.checks.filter((file) => !presentSet.has(file));
    undeclared += notDeclared.length;
    declaredWithNoFile += noFile.length;
    packages.push({
      package: packageName,
      declares: Boolean(declaration.declared),
      present_count: present.length,
      undeclared_check_files: notDeclared,
      declared_names_matching_no_file: noFile,
    });
  }
  return {
    packages,
    totals: {
      packages_read: packages.length,
      undeclared_check_files: undeclared,
      declared_names_matching_no_file: declaredWithNoFile,
    },
  };
}

/** The policy half, kept apart from the facts so a caller can see what it chose. */
export function exitCodeFor(totals, options) {
  for (const [outcome, count] of Object.entries(totals)) {
    if (!(count > 0)) continue;
    if (NOT_A_FINDING.has(outcome)) continue;
    // The two the CALLER is allowed to decide about, and each is a named option rather than a
    // second boolean meaning the same thing. Everything else falls through and fails.
    if (outcome === 'no_runner') {
      if (options.tolerateMissingRunner) continue;
      return 1;
    }
    if (outcome === 'packages_declaring_nothing') {
      if (options.requireChecks) return 1;
      continue;
    }
    return 1;
  }
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    // A refused ARGUMENT is a usage answer, not a crash. Left to throw, it arrives as a stack whose
    // top frame is the ESM loader, which buries the one sentence that says what to do instead.
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.packageSetFolder && options.everyPackage) {
    // Named packages still win when both are given: an explicit name is a narrower request, and
    // silently widening it to the whole set would be the opposite of what the caller typed.
    if (options.packages.length === 0) {
      options.packages = await everyPackageInTheSet(
        options.packageSetFolder,
        options.packagesSubfolder,
      );
    }
  }
  if (!options.packageSetFolder || options.packages.length === 0) {
    console.error('usage: --package-set-folder <absolute path> --package <name> [--package <name>...]');
    console.error('       [--every-package-in-the-set]  every package the set folder holds');
    console.error(`       [--packages-subfolder <name>]  where subjects sit, default "${PACKAGES_SUBFOLDER}"`);
    console.error('       [--list] [--tolerate-missing-runner] [--require-checks] [--timeout-ms <n>]');
    console.error('       [--report-undeclared-check-files]  what is present and undeclared, and');
    console.error('                                          what is declared but has no file');
    process.exitCode = 2;
    return;
  }
  if (options.reportUndeclaredCheckFiles) {
    const report = await undeclaredCheckFilesReport(
      options.packageSetFolder,
      options.packages,
      options.packagesSubfolder,
    );
    console.log(JSON.stringify(report, null, 2));
    // Not an exit-code failure. This answers "what is not being verified", which is a question
    // about adoption; the run path answers "did what is declared pass". Conflating them would make
    // every package with one undeclared file look like a package with a failing test.
    process.exitCode = 0;
    return;
  }
  const report = buildReport(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = options.listOnly ? 0 : exitCodeFor(report.totals, options);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
