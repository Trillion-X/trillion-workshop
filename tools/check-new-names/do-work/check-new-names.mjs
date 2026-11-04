#!/usr/bin/env node
// tools/check-new-names/do-work/check-new-names.mjs
//
// A folder or file name a change adds says what the thing is or does: a new reader can point at it without asking.
// Which names fail is the caller's DATA (the rules), never this file's:
//
//   { repositories?: ["owner/name", ...],                 judged only when the checkout's origin names one of these
//     words: [{ why, words: ["legacy", ...] }],           a name holding one of these words fails, saying why
//     patterns: [{ why, pattern: "regular expression" }], a word of a name matching one fails, saying why
//     passes: ["blake3", "postgres", ...] }               words that are outside names (a format, a product) and pass
//
// A name is read as words: split at - _ . and spaces and where lower case meets upper case, lower-cased, its file
// extension left out. Only a name the change brings in is judged: a file it adds or renames, and each folder of that
// path its base tree did not hold, so a name already there is not judged again until a change moves it.
//
//   node check-new-names.mjs --root CHECKOUT (--staged | --range FROM..TO | --for-command COMMAND) --rules-json RULES
//   node check-new-names.mjs --root CHECKOUT --input-on-stdin < { rules, range? }   (the Workshop tool; prints { result })
//
// --for-command judges what that command would publish: a `git commit` the staged index, a `git push` the commits
// from where HEAD left origin/main; any other command nothing. Prints { valid, judged, refused: [{ path, name, word,
// why }] }; exits 0 when every new name passes or nothing is judged, 2 when a name fails (the refusal is printed on
// stderr in plain words), 1 when it could not judge.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { text } from 'node:stream/consumers';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

function hasCommit(root, ref) {
  return spawnSync('git', ['-C', root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0;
}

// The span a shell command would publish, or null when it publishes nothing.
export function spanForCommand(root, command) {
  const parts = String(command).split(/&&|\|\||;|\n/).map((part) => part.trim()).filter((part) => /^git(\s+-C\s+\S+)?\s/.test(part));
  if (parts.some((part) => /\scommit(\s|$)/.test(part))) return { staged: true };
  if (parts.some((part) => /\spush(\s|$)/.test(part))) {
    const base = spawnSync('git', ['-C', root, 'merge-base', 'HEAD', 'refs/remotes/origin/main'], { encoding: 'utf8' });
    return { from: base.status === 0 ? base.stdout.trim() : EMPTY_TREE, to: 'HEAD' };
  }
  return null;
}

// The words of one name: `legacy_kept.rs` is ["legacy", "kept"], `nativeBoot` is ["native", "boot"].
export function wordsOf(name, isFile) {
  const stem = isFile && name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).map((word) => word.toLowerCase()).filter(Boolean);
}

// Why a name fails the rules ({ word, why }), or null when it passes.
export function failing(name, isFile, rules) {
  const passes = new Set((rules.passes ?? []).map((word) => word.toLowerCase()));
  const patterns = (rules.patterns ?? []).map((row) => ({ why: row.why, pattern: new RegExp(row.pattern) }));
  for (const word of wordsOf(name, isFile)) {
    if (passes.has(word)) continue;
    const listed = (rules.words ?? []).find((row) => row.words.some((one) => one.toLowerCase() === word));
    if (listed) return { word, why: listed.why };
    const matched = patterns.find((row) => row.pattern.test(word));
    if (matched) return { word, why: matched.why };
  }
  return null;
}

// [{ path, name, isFile }] for every name the span brings in: each added or renamed file, and each of its folders the
// base tree did not hold.
export function newNames(root, span) {
  const base = span.staged ? (hasCommit(root, 'HEAD') ? 'HEAD' : EMPTY_TREE) : span.from;
  const diff = span.staged ? ['diff', '--cached', '--name-only', '-z', '--diff-filter=AR', base]
    : ['diff', '--name-only', '-z', '--diff-filter=AR', span.from, span.to];
  const held = new Set(base === EMPTY_TREE ? [] : git(root, ['ls-tree', '-r', '-d', '--name-only', '-z', base]).split('\0').filter(Boolean));
  const found = new Map();
  for (const path of git(root, diff).split('\0').filter(Boolean)) {
    const parts = path.split('/');
    parts.forEach((name, at) => {
      const place = parts.slice(0, at + 1).join('/');
      const isFile = at === parts.length - 1;
      if ((isFile || !held.has(place)) && !found.has(place)) found.set(place, { path: place, name, isFile });
    });
  }
  return [...found.values()];
}

// Whether the checkout's origin is one the rules judge (every one is, when the rules name none).
export function judgedRepository(root, rules) {
  if (!rules.repositories?.length) return true;
  const origin = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const url = origin.status === 0 ? origin.stdout.trim().replace(/\.git$/, '') : '';
  return rules.repositories.some((name) => url.endsWith(`/${name}`) || url.endsWith(`:${name}`));
}

export function judgeNames({ root, span, rules }) {
  if (!judgedRepository(root, rules)) return { valid: true, judged: 0, refused: [], unjudged: 'the rules do not name this repository' };
  const names = newNames(root, span);
  const refused = names.map((one) => ({ ...one, failure: failing(one.name, one.isFile, rules) })).filter((one) => one.failure)
    .map(({ path, name, failure }) => ({ path, name, word: failure.word, why: failure.why }));
  return { valid: !refused.length, judged: names.length, refused };
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  const args = process.argv.slice(2);
  if (args.includes('--input-on-stdin')) {
    // Run as the Workshop tool on a folder the person granted: { rules, range? } on stdin (no range: the staged index),
    // and { result } on the last line, a refusal being a result like any other.
    try {
      const input = JSON.parse((await text(process.stdin)) || '{}');
      if (!input.rules || typeof input.rules !== 'object') throw new Error('give rules: { words, patterns, passes, repositories? }');
      const span = input.range ? { from: String(input.range).split('..')[0], to: String(input.range).split('..')[1] } : { staged: true };
      console.log(JSON.stringify({ result: judgeNames({ root: option(args, '--root'), span, rules: input.rules }) }));
    } catch (error) {
      console.log(JSON.stringify({ error: String(error?.message ?? error) }));
      process.exitCode = 1;
    }
    process.exit();
  }
  try {
    const root = option(args, '--root') ?? process.cwd();
    const command = option(args, '--for-command');
    const range = option(args, '--range');
    const span = command !== undefined ? spanForCommand(root, command) : args.includes('--staged') ? { staged: true }
      : range ? { from: range.split('..')[0], to: range.split('..')[1] } : undefined;
    if (span === null) {
      console.log(JSON.stringify({ valid: true, judged: 0, refused: [], unjudged: 'the command commits and pushes nothing' }));
      process.exit(0);
    }
    if (!span) throw new Error('give --staged, --range FROM..TO or --for-command COMMAND');
    const result = judgeNames({ root, span, rules: JSON.parse(option(args, '--rules-json') ?? '{}') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) {
      process.stderr.write(`A new name must say what the thing is or does, so a new reader can point at it without asking:\n${
        result.refused.map((one) => `  ${one.path}: "${one.word}" is ${one.why}`).join('\n')}\nRename it to the job it does or the thing it holds.\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    console.log(JSON.stringify({ valid: false, errors: [String(error?.message ?? error)] }, null, 2));
    process.exitCode = 1;
  }
}
