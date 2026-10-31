#!/usr/bin/env node
// Run rules a person wrote over the source files of one folder.
//
// This is the disk half, kept OUT of the engine on purpose: every environment difference lives
// here (git or not, worktrees, generated files, symlinks), and absorbing it would make the engine
// untestable without a disk.
//
// It reads the working tree rather than the index, because a check reports what is actually
// on disk. A file git still tracks but that is no longer there belongs to somebody else's
// pending deletion, and reporting it as missing would be reporting their work as your bug.
//
// Usage (every path absolute):
//   node do-work/run-check-source-files-against-declared-rules.mjs \
//     --repo <folder> --rules <rules.json> [--under <subdir>] [--recorded <baseline.json>] [--json]
//
// `--rules` names ONE file and reads every record whose payload kind is `source-file-rule`, from a
// list or from `{things: [...]}`. A run with no rule is refused rather than reported clean.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceFileInRepository } from './read-source-file-in-repository.mjs';

import {
  countByRuleAndPath,
  differenceFromRecorded,
  fileConditionHolds,
  reportByRule,
  ruleCoversPath,
  violationsAcrossFiles,
} from './check-source-files-against-declared-rules.mjs';

function argumentValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index === -1 || index + 1 >= process.argv.length ? fallback : process.argv[index + 1];
}

/** Rules are records, so reading them is reading records. A file that declares none is not
 *  an error worth guessing about: it is reported, because a silent zero-rule run is
 *  indistinguishable from a clean repository. */
export function rulesFromPackageData(text) {
  const parsed = JSON.parse(text);
  const things = Array.isArray(parsed) ? parsed : (parsed?.things ?? []);
  return things
    .map((thing) => thing?.payload)
    .filter((payload) => payload && payload.kind === 'source-file-rule');
}

/** A recorded finding set, as written by hand, in the shape the tested helpers compare.
 *
 *  The file lists `path:line` strings under each rule id, and the helpers count per PATH, which
 *  is deliberate and is the reason this conversion exists rather than a second comparator: a
 *  line number moves whenever anything above it does, so a record keyed on lines churns on edits
 *  that have nothing to do with it, and a record that churns is one people regenerate instead of
 *  read. Two findings in one file are two, whatever lines they sit on.
 *
 *  A whole-file finding has no line, so its entry is a bare path. Splitting on the LAST colon
 *  and requiring digits is what keeps those two shapes apart without the record having to say
 *  which it is. */
export function recordedCountsFrom(text) {
  const known = JSON.parse(text)?.known_findings ?? {};
  const counted = {};
  for (const [ruleId, places] of Object.entries(known)) {
    if (!Array.isArray(places)) {
      // A string here iterates by CHARACTER in every `for...of` that reads it, so one sentence of
      // prose becomes several hundred phantom entries. It has happened THREE times, by three
      // authors, two of whom had just read the note in this file warning against it. So the refusal
      // names the REMEDY and not only the type: a reader who is told what is wrong still has to
      // guess where the prose goes, and the guess that fails is "somewhere else inside this map".
      const shown = ruleId.length > 60 ? `${ruleId.slice(0, 60)}...` : ruleId;
      throw new Error(`known_findings["${shown}"] must be an array of "path" or "path:line", got `
        + `${typeof places}. If this is a NOTE rather than a rule id, move it to the TOP LEVEL of `
        + `the baseline, a sibling of known_findings, where the other prose notes live. `
        + `known_findings holds rule ids only.`);
    }
    counted[ruleId] ??= {};
    for (const place of places) {
      const cut = place.lastIndexOf(':');
      const file = cut > 0 && /^[0-9]+$/.test(place.slice(cut + 1)) ? place.slice(0, cut) : place;
      counted[ruleId][file] = (counted[ruleId][file] ?? 0) + 1;
    }
  }
  return counted;
}

export function zeroBaselineState(rules, violations, recordedDocument = {}) {
  const ruleIds = new Set(
    rules.filter((rule) => rule.baseline_policy === 'zero').map((rule) => rule.id),
  );
  const known = recordedDocument?.known_findings ?? {};
  const recorded = [];
  for (const ruleId of ruleIds) {
    const rows = known[ruleId] ?? [];
    if (!Array.isArray(rows)) {
      recorded.push({ rule_id: ruleId, path: '(invalid recorded findings)', recorded: 1 });
      continue;
    }
    for (const place of rows) recorded.push({ rule_id: ruleId, path: place, recorded: 1 });
  }
  return {
    rule_ids: [...ruleIds].sort(),
    violations: violations.filter((row) => ruleIds.has(row.rule_id)),
    recorded,
  };
}

/** Every path git can name in the repository, from ONE git process: the index (`--cached`) and
 *  the untracked non-ignored working tree (`--others --exclude-standard`), told apart by `-t`
 *  (`?` is untracked; every other tag is an index entry).
 *
 *  One launch, not one per question, because a launch is the cost. Measured 2026-10-27 at 8:23 AM
 *  PDT, load 16 on 18 cores: `git ls-files` did about 2 ms of work and took 2.5 s of wall time,
 *  all of it macOS exec admission (`/usr/bin/true` took 0.35-0.9 s the same minute). Two
 *  listings plus a `--under` re-listing were three of those waits; the commit gate that consumes
 *  this runner refused good commits three times on its fixed 5 s budget before any rule ran.
 *
 *  `--under` narrows in process rather than with a second pathspec launch: it names a directory,
 *  so a prefix test on the one listing is the same answer. */
export function repositoryPaths(repoRoot) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { tracked: walkedPaths(repoRoot), untracked: [], listed_by: 'folder-walk' };
  }
  const tracked = [];
  const untracked = [];
  for (const entry of listed.split('\0')) {
    if (!entry) continue;
    if (entry.length < 3 || entry[1] !== ' ') throw new Error('git ls-files -t returned an untagged entry');
    (entry[0] === '?' ? untracked : tracked).push(entry.slice(2));
  }
  return { tracked, untracked, listed_by: 'git' };
}

/** A folder that is not a git repository (or one git cannot list, as inside a sandbox that may not
 *  start git) has no index to ask, so every file in it is a path, depth first, as git would write
 *  it. The folders a project keeps other people's code or its own history in are not the person's
 *  source and are left out, as `--exclude-standard` leaves out what a project ignores. A symbolic
 *  link is listed as a path and never followed: the reader refuses it where a rule needs content. */
const NOT_SOURCE_FOLDERS = new Set(['.git', 'node_modules']);
function walkedPaths(repoRoot, relative = '') {
  const found = [];
  for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!NOT_SOURCE_FOLDERS.has(entry.name)) found.push(...walkedPaths(repoRoot, name));
    } else {
      found.push(name);
    }
  }
  return found;
}

function insideDirectory(repoRoot, under) {
  if (!under) return () => true;
  const prefix = path.posix.normalize(path.relative(path.resolve(repoRoot), path.resolve(repoRoot, under))
    .split(path.sep).join('/'));
  if (prefix === '.' || prefix === '') return () => true;
  if (prefix === '..' || prefix.startsWith('../')) throw new Error('--under must name a directory inside --repo');
  return (file) => file === prefix || file.startsWith(`${prefix}/`);
}

/** The files this run is structurally unable to judge: present on disk, matched by a rule's
 *  scope, and absent from the index. `--exclude-standard` keeps deliberately ignored output out,
 *  so what remains is source somebody wrote and never added.
 *
 *  This is reported and does NOT fail the run. Counting them found 182 in a large project on
 *  2026-09-05, and making that an error would fail every build over other lanes' in-flight work.
 *  The defect being fixed here is a SILENCE, not the files: the header used to say "anything
 *  untracked was NOT judged" with no number, which reads like a footnote at 0 and like an
 *  emergency at 182, and the sentence was identical either way. */
function untrackedInScopeFiles(paths, rules) {
  return paths.filter((file) => rules.some((rule) => ruleCoversPath(rule, file)));
}

function uniqueSorted(paths) {
  return [...new Set(paths)].sort();
}

function readRuleSource(file, repoRoot = null) {
  const source = repoRoot
    ? readSourceFileInRepository(repoRoot, path.relative(path.resolve(repoRoot), file))
    : readSourceFileInRepository(path.dirname(path.resolve(file)), path.basename(file));
  if (source.status !== 'read') throw new Error(`source-rule policy unavailable: ${source.reason ?? source.status}`);
  return source.text;
}

// A named path/corpus subject need not read a payload. Content conditions and explicit
// collected text subjects still require actual bytes. Custody policy stays in rule DATA.
function ruleNeedsContent(rule) {
  const mentionsText = value => value !== null && typeof value === 'object'
    && (value.from_subject === 'text' || Object.values(value).some(mentionsText));
  return !rule.subject?.named || rule.subject.named === 'text'
    || rule.applies_when != null || mentionsText(rule.violation);
}

/** Two packages claiming the same rule id would double-report one finding and make a ratchet
 *  count drift with no edit to either rule, so it is refused rather than merged. */
/** A run that cannot report honestly. The CLI turns it into exit status 2; an in-process caller
 *  receives it as a thrown error, so a refusal never becomes a returned clean summary. */
export class RunRefusal extends Error {}

function assertRuleIdsAreUnique(rules) {
  const seen = new Map();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new RunRefusal(`two source-file-rule records share the id ${rule.id}; ids are how findings are counted, so this is refused`);
    }
    seen.set(rule.id, true);
  }
}

/** The whole check as one call, so a consumer in another process (the commit gate's judge) can
 *  import it instead of launching this file as a second node process and parsing its stdout.
 *  Returns `{summary, failed}`: `summary` is exactly the `--json` document, `failed` is the
 *  exit decision. Throws `RunRefusal` where the CLI exits 2. */
export function checkRepository({ repoRoot, rules: given = null, rulesPath = null, under = null, recorded = null, recordedPath = null }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new RunRefusal('--repo <repo-root> is required, as an absolute path');
  }
  const { tracked: trackedCorpus, untracked: untrackedCorpus, listed_by: listedBy } = repositoryPaths(repoRoot);
  const corpus = uniqueSorted([...trackedCorpus, ...untrackedCorpus]);
  const rules = given ?? (rulesPath ? rulesFromPackageData(readRuleSource(rulesPath)) : []);
  if (rules.length === 0) {
    throw new RunRefusal(`no source-file-rule records ${rulesPath ? `in ${rulesPath}` : 'were given'}; refusing to report a clean run`);
  }
  assertRuleIdsAreUnique(rules);
  if (rules.some(rule => rule.requires_regular_file !== undefined && typeof rule.requires_regular_file !== 'boolean')) {
    throw new Error('requires_regular_file must be a declared boolean');
  }

  // Only read a file some rule could care about. The scope test is on the path alone, so
  // this costs nothing and keeps a large repository off the heap.
  const inside = insideDirectory(repoRoot, under);
  const tracked = trackedCorpus.filter(inside);
  const untracked = untrackedCorpus.filter(inside);
  const trackedSet = new Set(tracked);
  const judgedPaths = uniqueSorted([...tracked, ...untracked]);
  const files = [];
  const refusedPaths = [];
  const danglingPaths = [];
  let inScopeGoneFromDisk = 0;
  for (const file of judgedPaths) {
    const scopedRules = rules.filter(rule => ruleCoversPath(rule, file));
    if (!scopedRules.length) continue;
    const contentRequired = scopedRules.some(ruleNeedsContent);
    const source = readSourceFileInRepository(repoRoot, file, {contentRequired,
      regularRequired: contentRequired || scopedRules.some(rule => rule.requires_regular_file === true)});
    if (source.status === 'missing') {
      // Somebody's pending deletion, per the header note. Skipping it is right; skipping it
      // WITHOUT SAYING SO made the file count below the intersection of index and disk, which is
      // neither of the two numbers a reader assumes it is.
      if (trackedSet.has(file)) inScopeGoneFromDisk += 1;
      continue;
    }
    if (source.status !== 'read') {
      (source.status === 'dangling' ? danglingPaths : refusedPaths).push(file);
      continue;
    }
    files.push({ path: file, text: source.text, content_read: source.content_read });
  }
  const successfullyRead = new Set(files.map(file => file.path));
  const judgedUntracked = untrackedInScopeFiles(untracked, rules).filter(file => successfullyRead.has(file));
  const ruleCoverage = rules.map(rule => {
    const scoped = files.filter(file => ruleCoversPath(rule, file.path));
    return {rule_id: rule.id, scoped_files: scoped.length,
      applicable_files: scoped.filter(file => fileConditionHolds(rule.applies_when, file.text)).length};
  });
  const noApplicableRule = !ruleCoverage.some(row => row.applicable_files > 0);

  // WHAT EXISTS, as one newline-joined string, supplied to every rule as a second subject.
  //
  // A rule reading one document can never answer "does the thing this line names still exist",
  // because existence is a fact about the whole folder, not about one file. So the runner supplies
  // every path as a second subject, and a rule reads it by name.
  //
  // Nothing here knows the word "package". The runner supplies paths; a rule decides what a name
  // looks like and where it is declared, which keeps the vocabulary in DATA where the next
  // reference shape costs a record rather than an edit to this file.
  //
  // Tracked AND untracked-not-ignored, deliberately. This is the full repository corpus even
  // when `--under` narrows which files are judged: a scoped run must not turn a valid reference
  // outside that directory into a missing one.
  const everyPath = corpus.join('\n');

  const violations = violationsAcrossFiles(rules, files, {
    every_path: everyPath,
  });
  const report = reportByRule(rules, violations);

  // The ratchet, when the caller names a recorded set. Both directions matter and only one of
  // them is obvious: `appeared` is what got worse, and `fixed` is what got BETTER while still
  // being listed, which is what separates a ratchet from a permission slip. Leaving a paid debt
  // written down re-permits the exact thing somebody just repaired.
  //
  // The third argument is the EVIDENCE THAT A LOOK HAPPENED, and without it a `fixed` row is a
  // guess. This runner already knew the difference, since it computes
  // `in_scope_tracked_but_gone_from_disk` a few lines down, but it was not telling the comparison,
  // so a recorded finding in a file that had been DELETED came back as "found 0, delete this
  // entry" alongside genuine repairs and indistinguishable from them.
  const recordedDocument = recorded ?? (recordedPath ? JSON.parse(readRuleSource(recordedPath)) : {});
  const ratchet = (recorded ?? recordedPath)
    ? differenceFromRecorded(
      countByRuleAndPath(violations),
      recordedCountsFrom(JSON.stringify(recordedDocument)),
      files.map((file) => file.path),
    )
    : null;
  const zeroBaseline = zeroBaselineState(rules, violations, recordedDocument);

  // A clean report covers the working tree, not only Git's index. Source is dangerous before it
  // is staged too: an untracked package set, manifest, deploy wrapper, or symlink-shaped redirect
  // can still be executed. The runner therefore judges every tracked and untracked non-ignored
  // path on disk and reports how many of the judged inputs are not yet tracked.
  const scannedFrom = listedBy === 'git' ? 'working tree: tracked plus untracked non-ignored files'
    : 'working tree: every file in the folder (it is not a git repository, or git could not list it)';

  // With a recorded set the question CHANGES, and so does the answer. Without one, any finding
  // is a failure, which is the day-one-red behaviour a baseline exists to avoid. With one, the
  // failure is movement in either direction: something new, or something paid off and still
  // written down. A run that matches its record exactly exits 0 while reporting findings, and
  // that is the point.
  //
  // `unverified` is deliberately NOT a failure, and the reason is the repair it would provoke. It
  // means the recorded file was never looked at on this run, usually because it is gone from disk
  // while still tracked. Nothing moved in either direction, so there is nothing to ratchet. Were
  // it red, the cheapest way to make it green would be deleting the recorded entry, which records
  // a repair that never happened and drops the debt silently the moment the file comes back. It
  // prints instead, next to `in_scope_tracked_but_gone_from_disk`, which names the same fact from
  // the other end.
  const zeroBaselineFailed = zeroBaseline.violations.length > 0 || zeroBaseline.recorded.length > 0;
  const failed = noApplicableRule || refusedPaths.length > 0 || danglingPaths.length > 0 || zeroBaselineFailed
    || (ratchet ? ratchet.appeared.length > 0 || ratchet.fixed.length > 0 : violations.length > 0);
  return {
    failed,
    summary: {
      rules: rules.length,
      files: files.length,
      content_files: files.filter(file => file.content_read).length,
      scanned_from: scannedFrom,
      in_scope_untracked_judged: judgedUntracked.length,
      in_scope_untracked_paths: judgedUntracked,
      in_scope_tracked_but_gone_from_disk: inScopeGoneFromDisk,
      refused_paths: refusedPaths,
      dangling_paths: danglingPaths,
      rule_coverage: ruleCoverage,
      no_applicable_rule: noApplicableRule,
      violations,
      report,
      ratchet,
      zero_baseline: zeroBaseline,
    },
  };
}

function main() {
  const repoRoot = argumentValue('--repo');
  const recordedPath = argumentValue('--recorded');
  let checked;
  try {
    checked = checkRepository({ repoRoot: repoRoot && path.resolve(repoRoot), rulesPath: argumentValue('--rules'),
      under: argumentValue('--under'), recordedPath });
  } catch (error) {
    if (!(error instanceof RunRefusal)) throw error;
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const { summary, failed } = checked;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const {
      rules, files, scanned_from: scannedFrom, in_scope_untracked_judged: judgedUntracked,
      in_scope_tracked_but_gone_from_disk: inScopeGoneFromDisk, refused_paths: refusedPaths,
      dangling_paths: danglingPaths, no_applicable_rule: noApplicableRule, violations, report, ratchet,
      zero_baseline: zeroBaseline,
    } = summary;
    console.log(`${rules} rule(s) over ${files} file(s) from ${scannedFrom}: ${violations.length} finding(s)`);
    console.log(`  ${judgedUntracked} in-scope untracked file(s) were read and judged`);
    for (const file of refusedPaths) console.log(`  REFUSED_SOURCE  ${file}`);
    for (const file of danglingPaths) console.log(`  DANGLING_SOURCE  ${file}`);
    if (noApplicableRule) console.log('  UNJUDGED  no source file received an applicable rule');
    console.log(`  header math: ${inScopeGoneFromDisk} in-scope tracked path(s) are gone from disk and were skipped, so the file count above is the intersection of index and disk`);
    // Each rule's own count, beside the total in the header above.
    //
    // It was absent until 2026-09-09, and the cost was a number nobody could read off a run. A
    // reader wanting "how many does THIS rule report" had two choices, count the lines by eye or
    // run the rule alone and combine the totals by hand, and hand-combining is how a figure that
    // was never measured ends up in four documents and a commit message. A tool that makes
    // arithmetic the only path gets hand-arithmetic, and hand-arithmetic silently carries whatever
    // stale input it was given. Printing the parts beside the whole is what makes a disagreement
    // between them visible without anyone deciding to check.
    //
    // Deliberately NOT also asserting that the parts sum to the total: `report` is grouped FROM
    // `violations`, so that equality holds by construction and the assertion could never fail. A
    // verifier that cannot fail is worse than none.
    for (const entry of report) {
      console.log(`\n${entry.rule_id}  ${entry.violations.length} finding(s)\n  why: ${entry.why}`);
      for (const found of entry.violations) {
        const where = found.line === null ? found.path : `${found.path}:${found.line}`;
        console.log(`  ${where}${found.evidence ? `  ${found.evidence}` : ''}`);
      }
    }
    if (ratchet) {
      console.log(`\nagainst ${recordedPath}`);
      console.log(`  ${ratchet.appeared.length} appeared, ${ratchet.fixed.length} fixed but still recorded, ${ratchet.unverified.length} unverified`);
      for (const row of ratchet.appeared) {
        console.log(`  APPEARED  ${row.rule_id}  ${row.path}  found ${row.found}, recorded ${row.recorded}`);
      }
      for (const row of ratchet.fixed) {
        console.log(`  FIXED     ${row.rule_id}  ${row.path}  found ${row.found}, recorded ${row.recorded}  delete this entry`);
      }
      for (const row of ratchet.unverified) {
        console.log(`  UNVERIFIED  ${row.rule_id}  ${row.path}  recorded ${row.recorded}  ${row.reason}`);
      }
    }
    if (zeroBaseline.violations.length > 0 || zeroBaseline.recorded.length > 0) {
      console.log(`\nzero-baseline architecture rules`);
      for (const row of zeroBaseline.violations) {
        console.log(`  VIOLATION  ${row.rule_id}  ${row.path}${row.line === null ? '' : `:${row.line}`}`);
      }
      for (const row of zeroBaseline.recorded) {
        console.log(`  BASELINE_FORBIDDEN  ${row.rule_id}  ${row.path}`);
      }
    }
  }

  // The engine reports; the caller decides. This runner's caller is a shell, and a shell's
  // way of deciding is an exit code.
  //
  // `process.exitCode`, NEVER `process.exit()`. When stdout is a PIPE, node writes it
  // asynchronously, and `process.exit()` terminates without draining what is still queued. This
  // report is about 110KB and a pipe buffer is 64KB, so the JSON was being CUT MID-TOKEN, at
  // `"path": "p`, on every run big enough to matter. It was invisible from a terminal, where
  // stdout is synchronous and the whole report arrives, and that asymmetry is the entire reason
  // it survived: the human who eyeballs it uses a terminal, and the only consumer that uses a
  // pipe is the check. `packages/check-source-files-against-declared-rules/tests/declared-source-rules.test.mjs` calls
  // `JSON.parse(execFileSync(...))`, so it did not report findings, it threw a SyntaxError on
  // truncated bytes. A ratchet that cannot parse its own input cannot ratchet. Setting exitCode
  // lets node finish flushing and exit on its own with the same status.
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
