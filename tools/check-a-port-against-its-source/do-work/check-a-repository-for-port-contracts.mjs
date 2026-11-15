#!/usr/bin/env node
// tools/check-a-port-against-its-source/do-work/check-a-repository-for-port-contracts.mjs
//
// Every feature file a change adds, or grows past a number of lines, is claimed by a valid port contract: a port of
// an older owner, read by repository, commit and path, whose first commit was the byte copy and whose bytes still
// carry the source's lines; or a claim that nothing older does the job, whose search is run again here. One judge for
// a commit (the staged index), a push or a pull request (a range), and a repository's own test (everything since the
// rules' `since` commit). What a feature file is, where contracts live and which modes count are the repository's
// DATA, carried in the repository (default ports/feature-files.json), so a session that sees only that repository
// judges by the same rules:
//
//   { schema: "port-contracts/feature-files", since, feature_files: [{ matches, ignore?, added?, grown_lines_over? }],
//     contracts_match, contracts_in?: { repository, tree? }, modes, sources_by_repository?, retention_at_least?,
//     old_copy_days_at_most? }
//
// Which repositories a NO_PRIOR_OWNER claim must have searched (and the judge greps again) and the command that answers
// a job phrase with its nearest capability rows as JSON are the caller's: they describe the machine the judge runs on,
// not the repository. With neither, both searches are deferred, in words.
//
// A tree that does not hold the rules predates them and is reported unjudged; its commits are judged when they reach
// a tree that does (the pull request, the push to main).
//
//   node check-a-repository-for-port-contracts.mjs --root <checkout> (--staged | --range <from>..<to> | --since-rules
//     | --for-command <a shell command an AI is about to run>)
//     [--rules <path in the tree> | --rules-json <json>] [--search-repositories a,b,...] [--repositories <json>]
//     [--capability-search <json argv; the phrase is appended>] [--now <ISO time>]
//
// --for-command judges what that command would publish: a `git commit` the staged index, a `git push` the commits
// from where HEAD left origin/main; any other command nothing.
//
// Prints { valid, judged: [{ path, change, lines_added, contracts, errors, deferred }], errors } and exits 0 when
// valid, 1 when not, 2 when it could not judge. Deferred findings (a repository with no checkout here, a capability
// search not run here) are printed and never pass or refuse on their own.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitReaders } from './read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from './validate-reference-adaptation-contract.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const IS_CONTRACT = /(^|\/)ports\/.+\.json$/;

// [{ path, added: boolean, lines_added }] for a declared checkout; staged reads preserve its caller's private index.
export function changesOf(root, span) {
  return gitReaders({ root, tree: span.staged ? ':' : span.to }).changesOf(span);
}

function featurePath(rule, path) {
  return new RegExp(rule.matches).test(path) && !(rule.ignore && new RegExp(rule.ignore).test(path));
}

function featureRule(rules, change) {
  for (const rule of rules.feature_files ?? []) {
    if (!featurePath(rule, change.path)) continue;
    if (change.added && rule.added !== false) return 'added';
    if (!change.added && Number.isFinite(rule.grown_lines_over) && change.lines_added > rule.grown_lines_over) return 'grown';
  }
  return null;
}

function capabilitySearch(argv) {
  if (!argv?.length) return undefined;
  const asked = new Map();
  return (phrase) => {
    if (!asked.has(phrase)) {
      const ran = spawnSync(argv[0], [...argv.slice(1), phrase], { encoding: 'utf8', maxBuffer: 1 << 26 });
      let rows = null;
      try {
        rows = ran.status === 0 ? JSON.parse(ran.stdout) : null;
      } catch {
        rows = null;
      }
      asked.set(phrase, Array.isArray(rows) ? rows : null);
    }
    return asked.get(phrase);
  };
}

// The judgement of one span of one checkout. `span` is { staged: true } or { from, to }; `rules` the DATA above, or
// undefined to read `rulesPath` from the judged tree.
export function judgeRepository({ root, span, rules, rulesPath = 'ports/feature-files.json', searchRepositories = [],
  repositories = {}, capabilitySearchArgv, now } = {}) {
  const here = resolve(root);
  const tree = span.staged ? ':' : span.to;
  const readers = gitReaders({ root: here, repositories, repositoryNames: searchRepositories, tree });
  span = readers.snapshotSpan(span);
  if (!rules) {
    const bytes = readers.readTarget(rulesPath);
    // A tree with no rules predates them (a branch from before they began). It is judged when it reaches a tree that
    // has them: the pull request or the push to main, whose range then includes its commits.
    if (!bytes) {
      readers.assertScope();
      return { valid: true, judged: [], errors: [], unjudged: `${rulesPath} is not in the judged tree: it predates the port rules` };
    }
    rules = JSON.parse(bytes.toString('utf8'));
  }
  if (rules.schema !== 'port-contracts/feature-files') throw new Error('the rules are not port-contracts/feature-files');
  if (rules.since && !readers.hasCommit(rules.since)) throw new Error(`the rules' since commit ${rules.since} is not in this checkout's history`);
  // Nothing before the rules began is judged: a range that starts earlier (or at the empty tree) starts at `since`.
  const startsEarlier = (from) => rules.since && (!readers.hasCommit(from)
    || readers.commitIsAncestor(from, rules.since));
  const resolved = span.since ? { from: rules.since, to: span.to }
    : span.from !== undefined && startsEarlier(span.from) ? { from: rules.since, to: span.to } : span;

  // Contracts live in the judged tree, or where the rules' contracts_in names: { repository, tree? } (tree absent: the
  // files on disk in that checkout).
  const contractsMatch = new RegExp(rules.contracts_match);
  const away = rules.contracts_in && readers.checkout(rules.contracts_in.repository);
  if (rules.contracts_in && !away) throw new Error(`the contracts' repository ${rules.contracts_in.repository} has no checkout here`);
  const contractReader = away ? gitReaders({ root: away, tree: rules.contracts_in.tree }) : readers;
  const listed = contractReader.listPaths({ untracked: true });
  const contracts = [];
  const errors = [];
  const contractPaths = listed.filter((one) => contractsMatch.test(one));
  contractReader.prefetchTargets(contractPaths);
  for (const path of contractPaths) {
    try {
      contracts.push({ path, contract: JSON.parse(contractReader.readTarget(path).toString('utf8')) });
    } catch (error) {
      errors.push(`${path} is not a readable contract: ${error.message}`);
    }
  }

  // A union identifies candidate paths once per immutable repository revision. Each answer still uses
  // Git's original per-pattern expression and flags on those paths; filename matches remain independent.
  const changes = readers.changesOf(resolved);
  const selected = new Set(changes.filter(change => featureRule(rules, change)).map(change => change.path));
  const selectedSearches = contracts.filter(({contract}) => contract?.mode === 'NO_PRIOR_OWNER'
    && (contract.targets ?? []).some(target => selected.has(target?.path))).map(({contract}) => contract.proof?.search);
  const searchScope = [...searchRepositories, ...selectedSearches.flatMap(search =>
    Array.isArray(search?.repositories) ? search.repositories.map(row => row?.repository ??
      (row?.repository_multihash ? {repository_multihash: row.repository_multihash} : null)).filter(Boolean) : [])];
  readers.prepareCodeSearch?.(searchScope, selectedSearches.flatMap(search =>
    Array.isArray(search?.code_patterns) ? search.code_patterns : []));

  const options = {
    readers,
    activeTargetPaths: readers.listPaths().filter((path) => (rules.feature_files ?? []).some((rule) => featurePath(rule, path))),
    repository: readers.self,
    policySince: rules.since,
    searchRepositories,
    searchCapabilities: capabilitySearch(capabilitySearchArgv),
    isContract: (path) => IS_CONTRACT.test(path),
    modes: rules.modes,
    retentionAtLeast: rules.retention_at_least,
    oldCopyDaysAtMost: rules.old_copy_days_at_most,
    requireRepositorySources: rules.sources_by_repository !== false,
    now: now ?? new Date().toISOString(),
  };
  const judged = [];
  const validated = new Map();
  for (const change of changes) {
    const kind = featureRule(rules, change);
    if (!kind) continue;
    const claiming = contracts.filter(({ contract }) => (contract?.targets ?? []).some((target) => target?.path === change.path));
    // The claiming filter proves ownership of this exact path. Everything else validates the complete contract
    // against one immutable tree/options scope, so a second owned feature must not repeat its full searches.
    const results = claiming.map((entry) => {
      if (!validated.has(entry)) validated.set(entry, validateReferenceAdaptationContract(entry.contract,
        { ...options, stage: entry.contract?.status === 'VERIFIED' ? 'completion' : 'pre-edit' }));
      return { path: entry.path, ...validated.get(entry) };
    });
    const passing = results.filter((result) => result.valid);
    judged.push({
      path: change.path,
      change: kind,
      lines_added: change.lines_added,
      contracts: results.map(({ path, id, mode, status, valid }) => ({ path, id, mode, status, valid })),
      errors: passing.length ? [] : results.length ? results.flatMap((result) => result.errors.map((error) => `${result.path}: ${error}`))
        : [`no contract in ${rules.contracts_match} names ${change.path} in targets[].path`],
      deferred: [...new Set((passing.length ? passing : results).flatMap((result) => result.deferred))],
    });
  }
  readers.assertScope();
  return { valid: !errors.length && judged.every((one) => !one.errors.length), judged, errors };
}

// The span a shell command would publish, or null when it publishes nothing a port contract judges.
export function spanForCommand(root, command) {
  const git = String(command).split(/&&|\|\||;|\n/).map((part) => part.trim()).filter((part) => /^git(\s+-C\s+\S+)?\s/.test(part));
  if (git.some((part) => /\scommit(\s|$)/.test(part))) return { staged: true };
  if (git.some((part) => /\spush(\s|$)/.test(part))) {
    const base = gitReaders({ root }).mergeBase('HEAD', 'refs/remotes/origin/main');
    return { from: base ?? EMPTY_TREE, to: 'HEAD' };
  }
  return null;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const args = process.argv.slice(2);
  try {
    const root = option(args, '--root') ?? process.cwd();
    const range = option(args, '--range');
    const command = option(args, '--for-command');
    if (command !== undefined && !spanForCommand(root, command)) {
      console.log(JSON.stringify({ valid: true, judged: [], errors: [], unjudged: 'the command commits and pushes nothing' }));
      process.exit(0);
    }
    const span = command !== undefined ? spanForCommand(root, command) : args.includes('--staged') ? { staged: true }
      : range ? { from: range.split('..')[0], to: range.split('..')[1] }
        : args.includes('--since-rules') ? { since: true, to: 'HEAD' } : null;
    if (!span) throw new Error('give --staged, --range <from>..<to>, --since-rules or --for-command <command>');
    const rulesJson = option(args, '--rules-json');
    const result = judgeRepository({
      root,
      span,
      rules: rulesJson ? JSON.parse(rulesJson) : undefined,
      rulesPath: option(args, '--rules'),
      searchRepositories: (option(args, '--search-repositories') ?? '').split(',').filter(Boolean),
      repositories: JSON.parse(option(args, '--repositories') ?? '{}'),
      capabilitySearchArgv: option(args, '--capability-search') ? JSON.parse(option(args, '--capability-search')) : undefined,
      now: option(args, '--now'),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [String(error?.message ?? error)] }, null, 2));
    process.exitCode = 2;
  }
}
