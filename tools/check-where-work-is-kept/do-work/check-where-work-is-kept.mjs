#!/usr/bin/env node
// tools/check-where-work-is-kept/do-work/check-where-work-is-kept.mjs
//
// What an AI keeps goes into the person's Trillion lists, never onto disk. This judges one tool call before it runs:
// it finds every path the call would write (a Write or Edit's file_path; in a Bash command each redirect target and
// what tee, cp, mv, install, ln, mkdir, touch, dd, curl, wget, mktemp, tar, unzip and git archive write), places
// each one, and passes or refuses the call. A refusal names, for each refused path, the list to keep it in and the
// exact records:write call that keeps it there.
//
// Where a write may go is the caller's DATA (the rules), never this file's:
//
//   { source_repositories: ["owner/name", ...],   a checkout whose origin names one of these holds source
//     scratch: ".git/scratch",                    the one place under a checkout's .git an AI may write
//     new_files_refused: [{ why, pattern, except?, list? }],   a NEW file in a checkout whose path matches is refused
//     list_copies: [{ folder, list }],            folders the list-copy sync writes; an AI writing there is refused
//     list_copy_sync: "regular expression",       a Bash command matching it is the sync itself and passes whole
//     refused_places: [{ place, why, list? }],    places outside every declared checkout that are refused
//     lists: { "<list id>": { type, id_prefix?, value } },   how a record of each list is written
//     default_list: "<list id>",
//     classifier?: { rubric | rubrics_file + rubric_id, providers?, remember_file?, passes?, timeout_seconds,
//                    pass_answers: [...], lists_by_answer?: { answer: list id }, most_paths? },
//     says?: "the sentence a refusal ends with" }
//
// A path is placed in this order: under /dev it writes nothing kept and is not judged; in a checkout whose origin is
// a declared source repository it passes when tracked, when it is the checkout's scratch, or when it is new, not
// ignored and matches no `new_files_refused` row; in a `list_copies` folder it is refused naming that list; in a
// `refused_places` place (the longest matching place wins) it is refused naming its list. Any other path (and any
// path a command names with a variable this file cannot read) is unplaced: the classifier model is asked, through
// tools/ask-a-small-model-for-a-verdict (`ask`), with a timeout. A model that fails, times out or is not configured
// passes the path with a warning: a broken model never blocks all work.
//
//   node check-where-work-is-kept.mjs --root FOLDER [--file-path PATH] [--command COMMAND] --rules-json RULES
//   node check-where-work-is-kept.mjs --root FOLDER --input-on-stdin < { rules, call: { tool_name, tool_input } }
//
// The first is what a record:hook-guard row runs (tools/check-every-tool-call fills {tool_input.file_path} and
// {tool_input.command}): exit 0 passes in silence, 2 refuses with the plain words on stderr, 1 passes with a warning
// on stderr (a model that failed, rules that could not be read). The second is the Workshop tool: { result } on the
// last line, a refusal being a result like any other.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASK = join(HERE, '..', '..', 'ask-a-small-model-for-a-verdict', 'do-work', 'ask-a-small-model.mjs');

// ---------------------------------------------------------------------------------------------------------------
// Reading a shell command: heredoc bodies left out, then words, operators and redirects, quotes taken off.

function withoutHeredocBodies(command) {
  const lines = String(command).split('\n');
  const kept = [];
  let waiting = [];
  for (const line of lines) {
    if (waiting.length) {
      const { word, tabs } = waiting[0];
      if ((tabs ? line.replace(/^\t+/, '') : line) === word) waiting.shift();
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) waiting.push({ word: match[3], tabs: match[1] === '-' });
  }
  return kept.join('\n');
}

// [{ kind: 'word', text, dynamic } | { kind: 'op', text } | { kind: 'redirect', text }]. `dynamic` marks a word whose
// value this file cannot know: a variable other than HOME, TMPDIR or PWD, or a command substitution.
export function tokens(command) {
  const source = withoutHeredocBodies(command);
  const out = [];
  let at = 0;
  let word = null;
  const finish = () => { if (word !== null) out.push({ kind: 'word', text: word.text, dynamic: word.dynamic }); word = null; };
  const add = (piece, dynamic = false) => { word ??= { text: '', dynamic: false }; word.text += piece; word.dynamic ||= dynamic; };
  const substitution = (start) => { // $( ... ) with nesting; returns the index after it
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')' && (depth -= 1) === 0) return i + 1;
    }
    return source.length;
  };
  const variable = (start) => { // $NAME or ${NAME...}: [text, end, known]
    const braced = source[start + 1] === '{';
    const match = braced ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/.exec(source.slice(start)) : /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])/.exec(source.slice(start));
    if (!match) return ['$', start + 1, true];
    return [match[0], start + match[0].length, ['HOME', 'TMPDIR', 'PWD'].includes(match[1]) && (!braced || match[0] === `\${${match[1]}}`)];
  };
  while (at < source.length) {
    const ch = source[at];
    if (ch === '\\' && at + 1 < source.length) {
      if (source[at + 1] !== '\n') add(source[at + 1]);
      at += 2;
    } else if (ch === "'") {
      const end = source.indexOf("'", at + 1);
      add(source.slice(at + 1, end < 0 ? source.length : end));
      at = end < 0 ? source.length : end + 1;
    } else if (ch === '"') {
      let i = at + 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) { add(source[i + 1]); i += 2; } else if (source[i] === '$' && source[i + 1] === '(') {
          const end = substitution(i + 1); add(source.slice(i, end), true); i = end;
        } else if (source[i] === '$') { const [piece, end, known] = variable(i); add(piece, !known); i = end; } else if (source[i] === '`') {
          const end = source.indexOf('`', i + 1); add(source.slice(i, end < 0 ? source.length : end + 1), true); i = end < 0 ? source.length : end + 1;
        } else { add(source[i]); i += 1; }
      }
      word ??= { text: '', dynamic: false };
      at = i + 1;
    } else if (ch === '$' && source[at + 1] === '(') {
      const end = substitution(at + 1); add(source.slice(at, end), true); at = end;
    } else if (ch === '$') {
      const [piece, end, known] = variable(at); add(piece, !known); at = end;
    } else if (ch === '`') {
      const end = source.indexOf('`', at + 1); add(source.slice(at, end < 0 ? source.length : end + 1), true); at = end < 0 ? source.length : end + 1;
    } else if (ch === '#' && word === null) {
      const end = source.indexOf('\n', at); at = end < 0 ? source.length : end;
    } else if (/\s/.test(ch)) {
      finish();
      if (ch === '\n') out.push({ kind: 'op', text: '\n' });
      at += 1;
    } else {
      const rest = source.slice(at);
      const redirect = /^(?:[0-9]*>&[0-9-]*|[0-9]*<&[0-9-]*|&>>?|[0-9]*>>?\|?|[0-9]*<<<?-?|[0-9]*<>?)/.exec(rest);
      const fd = word !== null && !word.dynamic && /^[0-9]+$/.test(word.text) && /^[<>]/.test(rest);
      if (redirect) {
        const prefix = fd ? word.text : '';
        if (fd) word = null; else finish();
        out.push({ kind: 'redirect', text: prefix + redirect[0] });
        at += redirect[0].length;
      } else if (/^(\|\||&&|;;|[|;&()])/.test(rest)) {
        const op = /^(\|\||&&|;;|[|;&()])/.exec(rest)[0];
        finish();
        out.push({ kind: 'op', text: op });
        at += op.length;
      } else { add(ch); at += 1; }
    }
  }
  finish();
  return out;
}

// [{ words: [token], redirects: [{ op, target }], piped_from }]: the simple commands of a command line, in order.
function simpleCommands(command) {
  const list = [];
  let current = { words: [], redirects: [], separator: null };
  const all = tokens(command);
  for (let i = 0; i < all.length; i += 1) {
    const one = all[i];
    if (one.kind === 'op') {
      if (current.words.length || current.redirects.length) list.push(current);
      current = { words: [], redirects: [], separator: one.text };
    } else if (one.kind === 'redirect') {
      const target = all[i + 1]?.kind === 'word' && !/&/.test(one.text.replace(/^&>/, '')) && !/<</.test(one.text) ? all[(i += 1)] : null;
      if (one.text.startsWith('<<') || /^[0-9]*<</.test(one.text)) { if (all[i + 1]?.kind === 'word') i += 1; continue; }
      current.redirects.push({ op: one.text, target });
    } else current.words.push(one);
  }
  if (current.words.length || current.redirects.length) list.push(current);
  return list;
}

const OPTION_TAKES_VALUE = {
  cp: ['-S', '--suffix'], mv: ['-S', '--suffix'], install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix'],
  ln: ['-S', '--suffix'], mkdir: ['-m', '--mode', '--context'], touch: ['-r', '--reference', '-d', '--date', '-t'],
  tee: [], unzip: ['-x', '-P'],
};

function plainArguments(args, name) {
  const takes = OPTION_TAKES_VALUE[name] ?? [];
  const out = [];
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (options && arg.text === '--') { options = false; continue; }
    if (options && arg.text.startsWith('-') && arg.text !== '-') { if (takes.includes(arg.text)) i += 1; continue; }
    out.push(arg);
  }
  return out;
}

function valueOf(args, shorts, longs) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i].text;
    for (const long of longs) {
      if (arg === long) return args[i + 1];
      if (arg.startsWith(`${long}=`)) return { ...args[i], text: arg.slice(long.length + 1) };
    }
    if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--')) {
      for (let c = 1; c < arg.length; c += 1) {
        if (shorts.includes(arg[c])) return c === arg.length - 1 ? args[i + 1] : { ...args[i], text: arg.slice(c + 1) };
      }
    }
  }
  return undefined;
}

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'stdbuf', 'timeout']);

// What one simple command writes: [{ word, how }] where word is a token ({ text, dynamic }) or a made one.
function writesOf(simple) {
  const found = simple.redirects.filter((one) => one.target && /^(?:[0-9]*>|&>|[0-9]*<>)/.test(one.op))
    .map((one) => ({ word: one.target, how: `redirect ${one.op}` }));
  let words = simple.words.filter((one, at, all) => !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(one.text) && all.slice(0, at).every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text))));
  while (words.length && WRAPPERS.has(basename(words[0].text))) {
    const wrapper = basename(words[0].text);
    words = words.slice(1);
    while (words.length && (words[0].text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text) || (wrapper === 'timeout' && /^[0-9.]+[smhd]?$/.test(words[0].text)))) words = words.slice(1);
  }
  if (!words.length) return found;
  const name = basename(words[0].text);
  const args = words.slice(1);
  const made = (text, dynamic = false) => ({ text, dynamic });
  const add = (word, how) => { if (word) found.push({ word, how }); };
  if (name === 'tee') plainArguments(args, name).forEach((one) => add(one, 'tee'));
  else if (['cp', 'mv', 'install', 'ln'].includes(name)) {
    const target = valueOf(args, ['t'], ['--target-directory']);
    const plain = plainArguments(args, name).filter((one) => one !== target);
    if (name === 'install' && args.some((one) => one.text === '-d' || one.text === '--directory')) plain.forEach((one) => add(one, name));
    else if (target) add(target, name);
    else if (plain.length >= 2) add(plain.at(-1), name);
  } else if (name === 'mkdir' || name === 'touch') plainArguments(args, name).forEach((one) => add(one, name));
  else if (name === 'dd') args.filter((one) => one.text.startsWith('of=')).forEach((one) => add({ ...one, text: one.text.slice(3) }, 'dd of='));
  else if (name === 'curl') {
    const folder = valueOf(args, [], ['--output-dir']);
    const output = valueOf(args, ['o'], ['--output']);
    const prefix = (word) => (folder && !isAbsolute(word.text) ? { text: `${folder.text}/${word.text}`, dynamic: folder.dynamic || word.dynamic } : word);
    if (output) add(prefix(output), 'curl -o');
    const remoteName = args.some((one) => one.text === '--remote-name' || one.text === '--remote-name-all' || (/^-[A-Za-z]+$/.test(one.text) && one.text.includes('O')));
    if (remoteName) {
      const url = args.find((one) => /^[a-z]+:\/\//i.test(one.text));
      add(prefix(made(basename((url?.text ?? 'download').split(/[?#]/)[0]) || 'index.html', url?.dynamic)), 'curl -O');
    }
  } else if (name === 'wget') {
    const output = valueOf(args, ['O'], ['--output-document']);
    const folder = valueOf(args, ['P'], ['--directory-prefix']);
    if (output && output.text !== '-') add(output, 'wget -O');
    else if (!output) {
      const url = args.find((one) => /^[a-z]+:\/\//i.test(one.text));
      const file = basename((url?.text ?? 'index.html').split(/[?#]/)[0]) || 'index.html';
      add(folder ? { text: `${folder.text}/${file}`, dynamic: folder.dynamic } : made(file, url?.dynamic), 'wget');
    }
  } else if (name === 'mktemp') {
    const folder = valueOf(args, ['p'], ['--tmpdir']);
    const tmp = folder ? folder.text : (process.env.TMPDIR || '/tmp');
    add({ text: `${tmp.replace(/\/$/, '')}/tmp.XXXXXXXXXX`, dynamic: folder?.dynamic ?? false }, 'mktemp');
  } else if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const first = args[0]?.text ?? '';
    const cluster = first.startsWith('-') ? first.slice(1) : first;
    const extract = args.some((one) => one.text === '--extract' || one.text === '--get' || (/^-[A-Za-z]+$/.test(one.text) && one.text.includes('x'))) || (/^[A-Za-z]+$/.test(first) && cluster.includes('x'));
    const create = args.some((one) => one.text === '--create' || (/^-[A-Za-z]+$/.test(one.text) && one.text.includes('c'))) || (/^[A-Za-z]+$/.test(first) && cluster.includes('c'));
    if (extract) add(valueOf(args, ['C'], ['--directory']) ?? made('.'), 'tar -x');
    else if (create) {
      const file = valueOf(args, ['f'], ['--file']) ?? (/^[A-Za-z]+$/.test(first) && cluster.includes('f') ? args[1] : undefined);
      if (file && file.text !== '-') add(file, 'tar -c');
    }
  } else if (name === 'unzip') add(valueOf(args, ['d'], []) ?? made('.'), 'unzip');
  else if (name === 'git' && args[0]?.text === 'archive') {
    const output = valueOf(args.slice(1), ['o'], ['--output']);
    if (output) add(output, 'git archive -o');
  }
  return found;
}

function expandKnown(textValue, home, cwd) {
  return textValue.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home).replace(/\$\{?TMPDIR\}?/g, (process.env.TMPDIR || '/tmp').replace(/\/$/, ''))
    .replace(/\$\{?PWD\}?/g, cwd);
}

// [{ path, how, unreadable? }]: every path the call writes, made absolute against `cwd` (a `cd` earlier in the same
// command line moves it). A path naming a variable or command this file cannot read keeps its text, with unreadable.
export function writtenPaths(call, { cwd, home = homedir() } = {}) {
  const input = call?.tool_input ?? {};
  const tool = call?.tool_name ?? (input.command ? 'Bash' : 'Write');
  const absolute = (value) => normalize(resolve(cwd, expandKnown(value, home, cwd)));
  if (tool !== 'Bash') {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    return typeof path === 'string' && path ? [{ path: absolute(path), how: tool }] : [];
  }
  const out = [];
  // What a command substitution runs writes too: `f=$(mktemp)` makes a file.
  for (const inner of withoutHeredocBodies(input.command ?? '').matchAll(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g)) {
    out.push(...writtenPaths({ tool_name: 'Bash', tool_input: { command: inner[1] ?? inner[2] } }, { cwd, home }));
  }
  let here = cwd;
  for (const simple of simpleCommands(input.command ?? '')) {
    const words = simple.words;
    if (words[0]?.text === 'cd' || words[0]?.text === 'pushd') {
      const to = words[1];
      if (to && !to.dynamic && to.text !== '-') here = normalize(resolve(here, expandKnown(to.text, home, here)));
      else if (!to) here = home;
      continue;
    }
    for (const { word, how } of writesOf(simple)) {
      if (word.dynamic) out.push({ path: word.text, how, unreadable: true });
      else out.push({ path: normalize(resolve(here, expandKnown(word.text, home, here))), how });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Placing one path.

function checkoutOf(path) {
  let at = path;
  for (;;) {
    if (existsSync(join(at, '.git')) && basename(at) !== '.git') return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

function originOf(checkout) {
  const origin = spawnSync('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  return origin.status === 0 ? origin.stdout.trim().replace(/\.git$/, '').replace(/\/$/, '') : '';
}

function declared(origin, rules) {
  const url = origin.toLowerCase();
  return (rules.source_repositories ?? []).find((name) => url.endsWith(`/${name.toLowerCase()}`) || url.endsWith(`:${name.toLowerCase()}`));
}

const segments = (path) => path.split('/').filter(Boolean);

function segmentMatches(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  return new RegExp(`^${pattern.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(value);
}

// Whether `place` (segments, `*` one segment, `**` any number) matches the start of `path`.
function placeHolds(place, path) {
  const walk = (p, v) => {
    if (p === place.length) return true;
    if (place[p] === '**') { for (let skip = v; skip <= path.length; skip += 1) if (walk(p + 1, skip)) return true; return false; }
    return v < path.length && segmentMatches(place[p], path[v]) && walk(p + 1, v + 1);
  };
  return walk(0, 0);
}

function placeOf(text, home) {
  return segments(text.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?/, home));
}

// { verdict: 'pass' | 'refuse' | 'unplaced' | 'not-kept', why, list?, checkout?, repository? }
export function placePath(path, rules, { home = homedir() } = {}) {
  if (path === '/dev' || path.startsWith('/dev/')) return { verdict: 'not-kept', why: 'a device, which keeps nothing' };
  const checkout = checkoutOf(path);
  if (checkout) {
    const repository = declared(originOf(checkout), rules);
    if (repository) {
      const relative = path === checkout ? '' : path.slice(checkout.length + 1);
      const scratch = (rules.scratch ?? '.git/scratch').replace(/\/$/, '');
      if (relative === scratch || relative.startsWith(`${scratch}/`)) return { verdict: 'pass', why: `${repository}'s scratch`, checkout, repository };
      if (relative === '.git' || relative.startsWith('.git/')) return { verdict: 'unplaced', why: `inside ${repository}'s .git but not its scratch`, checkout, repository };
      if (!relative) return { verdict: 'pass', why: `${repository}'s checkout`, checkout, repository };
      if (spawnSync('git', ['-C', checkout, 'ls-files', '--error-unmatch', '--', relative], { stdio: 'ignore' }).status === 0) {
        return { verdict: 'pass', why: `${repository}'s tracked source`, checkout, repository };
      }
      if (spawnSync('git', ['-C', checkout, 'check-ignore', '-q', '--', relative], { stdio: 'ignore' }).status === 0) {
        return { verdict: 'unplaced', why: `ignored by ${repository}, so never its source`, checkout, repository };
      }
      const refused = (rules.new_files_refused ?? []).find((row) => new RegExp(row.pattern).test(relative) && !(row.except && new RegExp(row.except).test(relative)));
      if (refused) return { verdict: 'refuse', why: `a new ${refused.why} in ${repository}, which is not its source`, list: refused.list, checkout, repository };
      return { verdict: 'pass', why: `new source of ${repository}`, checkout, repository };
    }
  }
  const pathParts = segments(path);
  const copy = (rules.list_copies ?? []).find((row) => placeHolds(placeOf(row.folder, home), pathParts));
  if (copy) return { verdict: 'refuse', why: `the copy of ${copy.list} that the list-copy sync writes; write the row and the sync makes the file`, list: copy.list };
  const place = (rules.refused_places ?? []).map((row) => ({ row, parts: placeOf(row.place, home) }))
    .filter(({ parts }) => placeHolds(parts, pathParts)).sort((a, b) => b.parts.length - a.parts.length)[0];
  if (place) return { verdict: 'refuse', why: place.row.why, list: place.row.list };
  return { verdict: 'unplaced', why: checkout ? 'in a repository no rule declares a source owner of' : 'in no place the rules name' };
}

// ---------------------------------------------------------------------------------------------------------------
// The records:write that keeps it instead.

const slug = (value) => String(value).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kept';

function fill(value, names) {
  if (typeof value === 'string') return value.replace(/\{(name|path|file)\}/g, (_, key) => names[key]);
  if (Array.isArray(value)) return value.map((one) => fill(one, names));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, names)]));
  return value;
}

export function keepInstead(path, listId, rules) {
  const list = listId && rules.lists?.[listId] ? listId : rules.default_list;
  const row = rules.lists?.[list];
  if (!row) return { list: list ?? null, write: null };
  const names = { name: slug(basename(path)), path, file: basename(path) };
  const prefix = row.id_prefix ?? `${row.type}:`;
  return { list, write: { records: [{ id: `${prefix}${names.name}`, type: row.type, value: fill(row.value ?? { text: '<what you were writing>' }, names) }] } };
}

// ---------------------------------------------------------------------------------------------------------------
// The classifier: tools/ask-a-small-model-for-a-verdict `ask`, run as its own program with a timeout.

export function askTheModel(request, timeoutSeconds) {
  return new Promise((done) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (answer) => { if (!settled) { settled = true; clearTimeout(timer); done(answer); } };
    let child;
    try {
      child = spawn(process.execPath, [ASK, 'ask'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ error: `the model tool could not start: ${error.message}` });
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ error: `the model did not answer within ${timeoutSeconds} s` }); }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => finish({ error: `the model tool could not start: ${error.message}` }));
    child.on('close', () => {
      const last = out.trim().split('\n').at(-1) ?? '';
      try {
        const answer = JSON.parse(last);
        finish(answer.result ? { verdict: answer.result } : { error: answer.error ?? 'the model tool gave no result' });
      } catch {
        const said = err.trim().split('\n').filter((line) => /error/i.test(line)).at(-1) ?? err.trim().split('\n').at(-1);
        finish({ error: `the model tool gave no answer${said ? `: ${said.trim()}` : ''}` });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

function classifierContent(one, call) {
  const input = call?.tool_input ?? {};
  return [`path written: ${one.path}`, `written by: ${one.how}`, `why the rules could not place it: ${one.why}`,
    input.command ? `command: ${String(input.command).slice(0, 2000)}` : null,
    typeof input.content === 'string' ? `first lines written:\n${input.content.slice(0, 600)}` : null].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// One call judged.

export async function judgeCall({ call, root, rules, home = homedir(), ask = askTheModel }) {
  const command = call?.tool_input?.command;
  if (typeof command === 'string' && rules.list_copy_sync && new RegExp(rules.list_copy_sync).test(command)) {
    return { valid: true, judged: 0, passed: [], refused: [], warnings: [], unjudged: 'the command is the list-copy sync' };
  }
  const found = writtenPaths(call, { cwd: root, home });
  const passed = [];
  const refused = [];
  const warnings = [];
  const unplaced = [];
  for (const one of found) {
    const place = one.unreadable ? { verdict: 'unplaced', why: 'it names a value only the shell knows' } : placePath(one.path, rules, { home });
    if (place.verdict === 'not-kept') continue;
    if (place.verdict === 'pass') passed.push({ path: one.path, how: one.how, why: place.why });
    else if (place.verdict === 'refuse') refused.push({ path: one.path, how: one.how, why: place.why, ...keepInstead(one.path, place.list, rules) });
    else unplaced.push({ ...one, why: place.why });
  }
  const classifier = rules.classifier;
  for (const [at, one] of unplaced.entries()) {
    if (!classifier) { warnings.push(`${one.path}: ${one.why}, and no classifier is set; passed`); passed.push({ path: one.path, how: one.how, why: 'unplaced, no classifier' }); continue; }
    if (at >= (classifier.most_paths ?? 5)) { warnings.push(`${one.path}: ${one.why}; more unplaced paths than the classifier is asked about; passed`); passed.push({ path: one.path, how: one.how, why: 'unplaced, not asked' }); continue; }
    const { timeout_seconds: timeoutSeconds = 20, pass_answers: passAnswers = [], lists_by_answer: listsByAnswer = {}, most_paths: mostPaths, ...request } = classifier;
    void mostPaths;
    const answer = await ask({ passes: 1, ...request, content: classifierContent(one, call) }, timeoutSeconds);
    if (answer.error || !answer.verdict) {
      warnings.push(`${one.path}: ${one.why}; the classifier could not judge it (${answer.error ?? 'no verdict'}), so it passed`);
      passed.push({ path: one.path, how: one.how, why: 'unplaced, classifier failed' });
      continue;
    }
    const said = answer.verdict.answer;
    const list = listsByAnswer[said] ?? (rules.lists?.[said] ? said : null);
    if (passAnswers.includes(said) || said === true) passed.push({ path: one.path, how: one.how, why: `the classifier answered ${JSON.stringify(said)}` });
    else if (list || said === false) refused.push({ path: one.path, how: one.how, why: `the classifier read it as ${JSON.stringify(said)}, ${one.why}`, ...keepInstead(one.path, list, rules) });
    else {
      warnings.push(`${one.path}: the classifier answered ${JSON.stringify(said)}, which names no list and no passing answer; passed`);
      passed.push({ path: one.path, how: one.how, why: `the classifier answered ${JSON.stringify(said)}` });
    }
  }
  return { valid: !refused.length, judged: passed.length + refused.length, passed, refused, warnings };
}

export function refusalWords(result, rules) {
  const lines = ['Work an AI keeps goes into the person\'s Trillion lists, never onto disk.'];
  for (const one of result.refused) {
    lines.push(`  ${one.path} (${one.how}): ${one.why}.`);
    if (one.write) lines.push(`    Keep it in ${one.list} instead: records:write ${JSON.stringify(one.write)}`);
    else lines.push('    Keep it in the person\'s Trillion list for it (the rules name no list for this place).');
  }
  lines.push(rules.says ?? 'A file write passes only for a declared source repository\'s source, that repository\'s .git/scratch, or a list copy the list-copy sync makes.');
  return `${lines.join('\n')}\n`;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

if (process.argv[1] && isEntry()) {
  const args = process.argv.slice(2);
  const root = option(args, '--root') || process.cwd();
  const home = process.env.HOME || homedir();
  if (args.includes('--input-on-stdin')) {
    try {
      const input = JSON.parse((await text(process.stdin)) || '{}');
      if (!input.rules || typeof input.rules !== 'object') throw new Error('give rules: { source_repositories, refused_places, lists, default_list, ... }');
      if (!input.call || typeof input.call !== 'object' || !input.call.tool_input) throw new Error('give call: { tool_name, tool_input: { file_path } or { command } }');
      console.log(JSON.stringify({ result: await judgeCall({ call: input.call, root, rules: input.rules, home }) }));
    } catch (error) {
      console.log(JSON.stringify({ error: String(error?.message ?? error) }));
      process.exitCode = 1;
    }
    process.exit();
  }
  try {
    const rules = JSON.parse(option(args, '--rules-json') ?? 'null');
    if (!rules || typeof rules !== 'object') throw new Error('give --rules-json: { source_repositories, refused_places, lists, default_list, ... }');
    const command = option(args, '--command') ?? '';
    const filePath = option(args, '--file-path') ?? '';
    const call = command ? { tool_name: 'Bash', tool_input: { command } } : filePath ? { tool_name: 'Write', tool_input: { file_path: filePath } } : null;
    if (!call) process.exit(0);
    const result = await judgeCall({ call, root, rules, home });
    if (!result.valid) {
      process.stderr.write(refusalWords(result, rules));
      process.exitCode = 2;
    } else if (result.warnings.length) {
      process.stderr.write(`check-where-work-is-kept passed with warnings:\n${result.warnings.map((line) => `  ${line}`).join('\n')}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`check-where-work-is-kept could not judge, so the call passed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
