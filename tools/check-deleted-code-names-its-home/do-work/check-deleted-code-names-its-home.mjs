#!/usr/bin/env node
// tools/check-deleted-code-names-its-home/do-work/check-deleted-code-names-its-home.mjs
//
// A commit or push that deletes a source or test file is refused unless each deleted file names its new home or the
// decision that retired it:
//
// - a moved-from receipt (`moved-from.json`, as tools/move-code-between-trees writes it) in one of the rules'
//   repositories names the file, by its path (`from`) or, for a private source moved into a public tree, by the
//   identity of its path (`from_path_identity`, the BLAKE3 identity of tools/content-identity), with the receipt's
//   `source` naming the judged repository (or naming none); or
// - a row of the judged tree's retired-paths file covers the file (its `path` glob: `*` any characters but `/`, `**`
//   any characters, and a match covers everything under a matched folder) and carries the decision: `decision`
//   with `by`, `words` and `source`, or a `reason` that names the decision.
//
// A file git sees renamed inside the span is a move inside the tree: its home is the new path. Which files are judged,
// where receipts and retirements are read and every word the judge says are DATA (read-data/rules.json).
//
// The receipts are read from the checkouts on disk: the judged one through its index (a receipt staged in the same
// commit counts), each other repository from its checkout beside the judged one (a folder of that name), or from the
// folder `--repositories` names. A repository with no checkout here is said, and its receipts are not counted.
//
//   node check-deleted-code-names-its-home.mjs --root <checkout> (--staged | --range <from>..<to>
//     | --for-command <a shell command an AI is about to run>) [--repository <name>] [--repositories <json>]
//     [--rules-json <json>]
//
// --for-command judges what that command would publish, as tools/check-a-port-against-its-source does (the one owner
// of that reading): a `git commit` the staged index, a `git push` the commits from where HEAD left origin/main; any
// other command nothing.
//
// Prints the refusal in words, then { valid, judged: [{ path, home, how }], errors, unread } on the last line. Exits 0
// when every deleted file has a home or a decision, 1 when one has neither, 2 when it could not judge.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spanForCommand } from '../../check-a-port-against-its-source/do-work/check-a-repository-for-port-contracts.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const RULES = JSON.parse(readFileSync(new URL('../read-data/rules.json', import.meta.url), 'utf8'));
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

function hasCommit(root, ref) {
  return spawnSync('git', ['-C', root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0;
}

function say(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}

/** The identity of a path's text, as a public receipt names a private source path. */
export function pathIdentity(path) {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(path));
}

/** A retired-paths glob as a test of one path: `*` any but `/`, `**` any, and a match covers a folder's contents. */
export function globCovers(glob, path) {
  const pattern = String(glob).split('**').map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${pattern}(/.*)?$`).test(path);
}

/** Whether rules judge a path (a source or test file). */
export function isJudged(path, rules = RULES) {
  return rules.judged_files.some((rule) => new RegExp(rule.matches).test(path));
}

/** The deletions of a span: { deleted: [path], renamed: Map(old -> new) }. `span` is { staged: true } or { from, to }. */
export function deletionsOf(root, span) {
  const base = span.staged ? [hasCommit(root, 'HEAD') ? 'HEAD' : EMPTY_TREE] : [span.from, span.to];
  const rows = git(root, ['diff', ...(span.staged ? ['--cached'] : []), '-M', '--name-status', '-z', '--diff-filter=DR', ...base])
    .split('\0');
  const deleted = [];
  const renamed = new Map();
  for (let at = 0; at < rows.length && rows[at];) {
    const status = rows[at];
    if (status.startsWith('R')) {
      renamed.set(rows[at + 1], rows[at + 2]);
      at += 3;
    } else {
      deleted.push(rows[at + 1]);
      at += 2;
    }
  }
  return { deleted, renamed };
}

function treeText(root, span, path) {
  const ran = spawnSync('git', ['-C', root, 'show', `${span.staged ? '' : span.to}:${path}`], { maxBuffer: 1 << 28 });
  return ran.status === 0 ? ran.stdout.toString('utf8') : null;
}

// Every receipt entry of one checkout: [{ repository, from, from_path_identity, to, receipt }].
function receiptsIn(folder, { staged, span, rules }) {
  const { file_name: name, files_field: field, path_fields: paths, path_identity_fields: identities, repository_fields: sources } = rules.receipts;
  const listed = git(folder, ['ls-files', '-z', '--cached', ...(staged ? [] : ['--others', '--exclude-standard']), '--', `*${name}`, name])
    .split('\0').filter((one) => one && basename(one) === name);
  const entries = [];
  for (const receipt of new Set(listed)) {
    let text = staged ? treeText(folder, span, receipt) : null;
    if (text === null && existsSync(join(folder, receipt))) text = readFileSync(join(folder, receipt), 'utf8');
    let value;
    try {
      value = JSON.parse(text ?? 'null');
    } catch {
      continue;
    }
    if (!value || !Array.isArray(value[field])) continue;
    const repository = sources.map((one) => value[one]).find((one) => typeof one === 'string');
    for (const file of value[field]) {
      entries.push({
        repository: sources.map((one) => file[one]).find((one) => typeof one === 'string') ?? repository,
        from: paths.map((one) => file[one]).find((one) => typeof one === 'string'),
        from_path_identity: identities.map((one) => file[one]).find((one) => typeof one === 'string'),
        to: file.to,
        receipt,
      });
    }
  }
  return entries;
}

function decisionOf(row, rules) {
  const { decision_field: field, decision_needs: needs, reason_names_a_decision: names } = rules.retirements;
  const decision = row[field];
  if (decision && typeof decision === 'object' && needs.every((one) => typeof decision[one] === 'string' && decision[one].trim())) return decision;
  if (typeof row.reason === 'string' && new RegExp(names, 'i').test(row.reason)) return { words: row.reason, source: row.tag ?? null };
  return null;
}

/**
 * The judgement of one span of one checkout.
 * `repository` is the judged checkout's name (default: its folder's name); `repositories` maps a name to a checkout
 * folder, for repositories not beside it.
 */
export function judgeDeletions({ root, span, repository, repositories = {}, rules = RULES } = {}) {
  const here = resolve(root);
  const name = repository ?? basename(realpathSync(here));
  const { deleted, renamed } = deletionsOf(here, span);
  const judged = [];
  const unread = [];
  const wanted = deleted.filter((path) => isJudged(path, rules));
  const renames = [...renamed].filter(([path]) => isJudged(path, rules));
  for (const [path, to] of renames) judged.push({ path, home: { repository: name, path: to }, how: 'renamed in the same change' });
  if (!wanted.length) return { valid: true, judged, errors: [], unread };

  const entries = [];
  for (const one of rules.repositories) {
    const folder = one === name ? here : repositories[one] ?? join(dirname(here), one);
    if (!existsSync(join(folder, '.git')) && one !== name) {
      unread.push(`${one}: no checkout at ${folder}`);
      continue;
    }
    entries.push(...receiptsIn(folder, { staged: one === name && span.staged, span, rules }).map((entry) => ({ ...entry, in: one })));
  }
  const retiredRows = rules.retirements.files.flatMap((file) => {
    const text = treeText(here, span, file);
    if (text === null) return [];
    try {
      return (JSON.parse(text)[rules.retirements.rows_field] ?? []).map((row) => ({ ...row, file }));
    } catch {
      return [];
    }
  });

  const errors = [];
  for (const path of wanted) {
    const identity = pathIdentity(path);
    const receipt = entries.find((entry) => (!entry.repository || entry.repository === name)
      && (entry.from === path || entry.from_path_identity === identity));
    if (receipt) {
      judged.push({ path, home: { repository: receipt.in, path: receipt.to ?? null, receipt: receipt.receipt }, how: 'moved-from receipt' });
      continue;
    }
    const retired = retiredRows.find((row) => globCovers(row.path, path) && decisionOf(row, rules));
    if (retired) {
      judged.push({ path, home: null, how: 'retired', decision: decisionOf(retired, rules), retired_in: retired.file, tag: retired.tag ?? null });
      continue;
    }
    judged.push({ path, home: null, how: null });
    errors.push(say(rules.words.one, { path, repositories: rules.repositories.join(', ') }));
  }
  return { valid: !errors.length, judged, errors, unread };
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
    const span = command !== undefined ? spanForCommand(root, command) : args.includes('--staged') ? { staged: true }
      : range ? { from: range.split('..')[0], to: range.split('..')[1] } : undefined;
    if (span === null) {
      console.log(JSON.stringify({ valid: true, judged: [], errors: [], unjudged: 'the command commits and pushes nothing' }));
      process.exit(0);
    }
    if (!span) throw new Error('give --staged, --range <from>..<to> or --for-command <command>');
    const rulesJson = option(args, '--rules-json');
    const result = judgeDeletions({
      root,
      span,
      repository: option(args, '--repository'),
      repositories: JSON.parse(option(args, '--repositories') ?? '{}'),
      rules: rulesJson ? JSON.parse(rulesJson) : RULES,
    });
    if (!result.valid) {
      console.log(say(RULES.words.refused, { count: result.errors.length }));
      for (const line of result.errors) console.log(line);
    }
    console.log(JSON.stringify(result));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [String(error?.message ?? error)] }));
    process.exitCode = 2;
  }
}
