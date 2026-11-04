// tools/use-trillion-from-a-shell/do-work/replay-recorded-writes.mjs
//
// Purpose
//   `records replay-from-transcripts`: brings back the account rows AIs wrote, from the AIs' own transcripts on this
//   computer. Every records:write call a transcript holds whose own result says it succeeded gives its records: an MCP
//   run_resource_operation call, or a shell `<program> op @own-records records:write ARG` whose ARG is literal text, a
//   heredoc, a here-string, `echo`/`printf`/`cat FILE` piped in, or a FILE (`"$(cat FILE)"`, `- < FILE`) that the
//   transcript itself wrote or that is unchanged on disk since the call answered. The newest write of each record id
//   wins (the transcript's time of the call); a null value is a removal.
//
//     records replay-from-transcripts --since TIME       dry run: writes the inventory folder, never the account
//     records replay-from-transcripts --write --inventory FOLDER
//                                                        writes that folder's rows through records:write in batches,
//                                                        then reads a sample of each type back
//
//   The command program passes `host`: its own argument parser, home-path expansion, settings and the names it runs
//   under, so a shell line is read exactly as that program reads it.
//
// Non-negotiable invariants
//   1. Rows reach the account only through its door (records:write at @own-records); nothing here opens a store file.
//   2. A call is kept only on positive proof in its own result; a refused call is skipped and an unknown result listed.
//   3. A value is taken word for word from the transcript, or from a file unchanged since its call answered. An input
//      built at run time (a jq or python program, a variable) is listed as unresolved, never guessed.
//   4. A record whose newest value looks like a credential is written neither to the inventory nor to the account; only
//      its id is listed.
//   5. Where each AI keeps its transcripts, which rows are calls, results and file writes, what proves success and every
//      limit are DATA in replay-recorded-writes.json; the earliest call time is the person's input, never a default.
//   6. A batch carries one request key made from the inventory folder and the batch number, so a rerun of --write is
//      answered as the first run was and batches already written are not sent again.
//
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import settings from './replay-recorded-writes.json' with { type: 'json' };

const at = (value, path) => path.reduce((inner, key) => (inner == null ? undefined : inner[key]), value);
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const millis = value => (typeof value === 'number' ? value : Date.parse(value));
const localTime = ms => new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
/** JSON with every object's keys in order, so two equal values are equal text. */
export const canonical = value => JSON.stringify(value, (key, inner) => (object(inner) ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]])) : inner));

// ── Shell text ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The index just past the `)` that closes a `$(` opened before `from`, skipping quoted text inside it. */
function closeOf(text, from) {
  let depth = 1;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') { index += 1; continue; }
    if (char === "'") { const end = text.indexOf("'", index + 1); if (end < 0) return text.length; index = end; continue; }
    if (char === '"') { for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === '\\') index += 1; continue; }
    if (char === '(') depth += 1;
    if (char === ')' && (depth -= 1) === 0) return index + 1;
  }
  return text.length;
}

/** `cat PATH` with one literal path, as the inside of a `$( )`, or null. */
function catPath(inside) {
  const found = /^\s*cat\s+(?:'([^']+)'|"([^"$`\\]+)"|([^\s'"$`\\;&|<>()]+))\s*$/.exec(inside);
  return found ? found[1] ?? found[2] ?? found[3] : null;
}

/** One shell command line as its simple commands, in order: { words: [{ text, literal, quoted, cat }], redirects:
 *  [{ op, target, body, literalBody }], joiner } where joiner is the operator after it ('|' pipes it into the next).
 *  A word is literal when no part of it is decided at run time ($VAR, $( ), backquotes); `cat` names the file of a word
 *  that is exactly $(cat FILE). Heredoc bodies are attached to the redirect that opened them. */
export function shellCommands(text) {
  const commands = [], heredocs = [];
  let words = [], redirects = [], word = null, redirect = null;
  const start = () => (word ??= { text: '', literal: true, quoted: false, cat: null, parts: 0 });
  const endWord = () => {
    if (!word) return;
    if (redirect) { redirect.target = word; redirects.push(redirect); if (redirect.op === '<<' || redirect.op === '<<-') heredocs.push(redirect); redirect = null; }
    else words.push(word);
    word = null;
  };
  const endCommand = joiner => {
    endWord();
    if (redirect) { redirects.push(redirect); redirect = null; }
    if (words.length || redirects.length) commands.push({ words, redirects, joiner });
    else if (joiner === '|' && commands.length) commands[commands.length - 1].joiner = '|';
    words = []; redirects = [];
  };
  const openRedirect = op => {
    // A word of digits just before the operator names a file descriptor (2>&1), not an argument.
    if (word && word.literal && !word.quoted && /^\d+$/.test(word.text)) word = null;
    endWord();
    redirect = { op, target: null, body: null, literalBody: false };
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index], next = text[index + 1];
    if (char === '\\') {
      if (next === '\n') { index += 1; continue; }
      start().text += next ?? '';
      index += 1;
      continue;
    }
    if (char === "'") {
      start().quoted = true;
      const end = text.indexOf("'", index + 1);
      if (end < 0) { word.literal = false; word.text += text.slice(index + 1); index = text.length; continue; }
      word.text += text.slice(index + 1, end);
      word.parts += 1;
      index = end;
      continue;
    }
    if (char === '"') {
      start().quoted = true;
      word.parts += 1;
      let inner = index + 1;
      for (; inner < text.length && text[inner] !== '"'; inner += 1) {
        const letter = text[inner];
        if (letter === '\\' && '$`"\\\n'.includes(text[inner + 1] ?? '')) { if (text[inner + 1] !== '\n') word.text += text[inner + 1]; inner += 1; continue; }
        if (letter === '$' && text[inner + 1] === '(') {
          const end = closeOf(text, inner + 2);
          const path = catPath(text.slice(inner + 2, end - 1));
          if (path && text[end] === '"' && word.text === '' && word.parts === 1) word.cat = path;
          word.literal = false;
          inner = end - 1;
          continue;
        }
        if (letter === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(text[inner + 1] ?? '')) word.literal = false;
        if (letter === '`') word.literal = false;
        word.text += letter;
      }
      if (inner >= text.length) word.literal = false;
      index = inner;
      continue;
    }
    if (char === '$' && next === '(') {
      const fresh = !word;
      start();
      const end = closeOf(text, index + 2);
      const path = catPath(text.slice(index + 2, end - 1));
      if (path && fresh && !/[^\s;&|<>)]/.test(text[end] ?? ' ')) word.cat = path;
      word.literal = false;
      word.parts += 1;
      index = end - 1;
      continue;
    }
    if (char === '$' && /[A-Za-z_{0-9@*#?$!'-]/.test(next ?? '')) { start().literal = false; word.text += char; continue; }
    if (char === '`') { start().literal = false; const end = text.indexOf('`', index + 1); index = end < 0 ? text.length : end; continue; }
    if (char === ' ' || char === '\t') { endWord(); continue; }
    if (char === '\n') {
      endCommand('\n');
      // Each heredoc opened on this line takes the next lines up to its delimiter line.
      let from = index + 1;
      for (const doc of heredocs.splice(0)) {
        const delimiter = doc.target?.text ?? '';
        const lines = [];
        while (from <= text.length) {
          const end = text.indexOf('\n', from);
          const line = text.slice(from, end < 0 ? text.length : end);
          from = end < 0 ? text.length + 1 : end + 1;
          const plain = doc.op === '<<-' ? line.replace(/^\t+/, '') : line;
          if (plain === delimiter) break;
          lines.push(plain);
        }
        doc.body = lines.length ? `${lines.join('\n')}\n` : '';
        doc.literalBody = Boolean(doc.target?.quoted) || !/[$`\\]/.test(doc.body);
      }
      index = from - 1;
      continue;
    }
    if (char === '#' && !word) { const end = text.indexOf('\n', index); index = (end < 0 ? text.length : end) - 1; continue; }
    if (char === ';') { endCommand(';'); if (next === ';') index += 1; continue; }
    if (char === '&') {
      if (next === '&') { endCommand('&&'); index += 1; continue; }
      if (next === '>') { openRedirect('>'); index += text[index + 2] === '>' ? 2 : 1; continue; }
      endCommand('&');
      continue;
    }
    if (char === '|') { if (next === '|') { endCommand('||'); index += 1; } else { endCommand('|'); if (next === '&') index += 1; } continue; }
    if ((char === '(' || char === ')') && !word) { endCommand(char); continue; }
    if (char === '<') {
      if (next === '(') { start().literal = false; index = closeOf(text, index + 2) - 1; continue; }
      if (text.startsWith('<<<', index)) { openRedirect('<<<'); index += 2; continue; }
      if (text.startsWith('<<-', index)) { openRedirect('<<-'); index += 2; continue; }
      if (next === '<') { openRedirect('<<'); index += 1; continue; }
      if (next === '&') { openRedirect('<&'); index += 1; continue; }
      openRedirect('<');
      continue;
    }
    if (char === '>') {
      if (next === '(') { start().literal = false; index = closeOf(text, index + 2) - 1; continue; }
      if (next === '>') { openRedirect('>>'); index += 1; continue; }
      if (next === '&') { openRedirect('>&'); index += 1; continue; }
      if (next === '|') { openRedirect('>'); index += 1; continue; }
      openRedirect('>');
      continue;
    }
    start().text += char;
  }
  endCommand(null);
  return commands;
}

/** What a command piped into the next one prints, when the command line fixes it: `cat FILE` (a file to read), or
 *  `echo` / `printf '%s'` of literal words. */
function printedBy(command) {
  const [name, ...args] = command.words;
  if (!name?.literal || command.redirects.some(row => row.op === '>' || row.op === '>>')) return null;
  if (!args.every(word => word.literal)) return null;
  const texts = args.map(word => word.text);
  if (name.text === 'cat' && texts.length === 1 && !texts[0].startsWith('-')) return { file: texts[0] };
  if (name.text === 'echo') {
    const plain = texts[0] === '-n' ? texts.slice(1) : texts;
    if (plain.some(item => /^-[a-zA-Z]+$/.test(item))) return null;
    return { text: `${plain.join(' ')}${texts[0] === '-n' ? '' : '\n'}` };
  }
  if (name.text === 'printf') {
    if ((texts[0] === '%s' || texts[0] === '%s\\n') && texts.length === 2) return { text: texts[1] };
    if (texts.length === 1 && !/[%\\]/.test(texts[0])) return { text: texts[0] };
  }
  return null;
}

/** Every `<program> op <address> <method> ARG` in a shell command line, in order, as { order, input } where input is
 *  { text } (the JSON text the program read), { file } (a file it read from disk) or { problem }. `files` is how the
 *  transcript left each file it wrote (path -> { content }, content null for a change it cannot replay); `cwd` is where
 *  the command started. Files the line itself writes go into `files` in order. */
export function shellWrites(source, { host, cwd = null, files = new Map(), home = homedir(), rules = settings }) {
  const commands = shellCommands(source);
  const found = [], reads = [];
  let here = cwd;
  const pathOf = raw => {
    const path = host.expand(raw, home);
    return isAbsolute(path) ? resolve(path) : here ? resolve(here, path) : null;
  };
  for (const [index, command] of commands.entries()) {
    const words = command.words;
    if (words[0]?.literal && words[0].text === 'cd' && words.length === 2 && words[1].literal) here = pathOf(words[1].text) ?? here;
    const program = words.findIndex(word => word.literal && host.programs.has(basename(word.text)));
    if (program >= 0) {
      const marks = new Map();
      const texts = words.slice(program + 1).map((word, place) => {
        if (word.literal) return word.text;
        const mark = `\u0000${place}`;
        marks.set(mark, word);
        return mark;
      });
      let parsed = null;
      try { parsed = host.parseArgs(texts); } catch { parsed = null; }
      const [verb, address, method, arg] = parsed?.words ?? [];
      if (verb === 'op' && address === rules.write.address && method === rules.write.method) {
        const row = { order: found.length };
        if (arg === undefined) row.input = { problem: 'no_input' };
        else if (marks.has(arg)) {
          const word = marks.get(arg);
          const path = word.cat ? pathOf(word.cat) : null;
          row.input = path ? { file: path } : { problem: word.cat ? 'relative_path_without_cwd' : 'built_at_run_time' };
        } else if (arg !== '-') row.input = { text: arg };
        else {
          const into = command.redirects.find(item => ['<', '<<', '<<-', '<<<'].includes(item.op));
          const piped = index > 0 && commands[index - 1].joiner === '|';
          const before = piped ? printedBy(commands[index - 1]) : null;
          if (into?.op === '<') row.input = into.target?.literal ? { file: pathOf(into.target.text) } : { problem: 'built_at_run_time' };
          else if (into?.op === '<<' || into?.op === '<<-') row.input = into.literalBody ? { text: into.body } : { problem: 'built_at_run_time' };
          else if (into?.op === '<<<') row.input = into.target?.literal ? { text: `${into.target.text}\n` } : { problem: 'built_at_run_time' };
          else if (before?.file) row.input = { file: pathOf(before.file) };
          else if (before?.text !== undefined) row.input = { text: before.text };
          else row.input = { problem: piped ? 'built_at_run_time' : 'standard_input_unknown' };
        }
        if (row.input.file === null) row.input = { problem: 'relative_path_without_cwd' };
        if (row.input.file) {
          const kept = files.get(row.input.file);
          if (typeof kept?.content === 'string') row.input = { text: kept.content, from: 'transcript' };
          else reads.push({ path: row.input.file, command: index, row });
        }
        found.push(row);
      }
    }
    // What a command writes is known only when it is `cat` of a literal heredoc; any other write makes the file unknown.
    for (const out of command.redirects.filter(item => (item.op === '>' || item.op === '>>') && item.target)) {
      const path = out.target.literal ? pathOf(out.target.text) : null;
      if (!path) continue;
      const doc = command.redirects.find(item => item.op === '<<' || item.op === '<<-');
      const content = words.length === 1 && words[0].literal && words[0].text === 'cat' && doc?.literalBody ? doc.body : null;
      const before = files.get(path)?.content;
      files.set(path, { content: content === null ? null : out.op === '>>' ? (typeof before === 'string' ? before + content : null) : content });
      // A file this line changes after a call read it from disk was not read as it is now.
      for (const read of reads) if (read.path === path && read.command < index) read.row.input = { problem: 'file_changed_after_call' };
    }
  }
  return found;
}

// ── Transcript rows ──────────────────────────────────────────────────────────────────────────────────────────────

const compiledFor = new WeakMap();
const compiled = rules => {
  if (!compiledFor.has(rules)) {
    const credential = rules.credential_like;
    compiledFor.set(rules, {
      credentialPatterns: credential.value_patterns.map(pattern => new RegExp(pattern)),
      credentialKey: new RegExp(credential.key_names, 'i'),
      projections: rules.succeeded_projections.map(pattern => new RegExp(pattern)),
    });
  }
  return compiledFor.get(rules);
};

/** Whether a value looks like a credential: a string matching a known key shape, or a long string with no spaces under
 *  a key named like a secret. */
export function credentialLike(value, rules = settings) {
  const { credentialPatterns, credentialKey } = compiled(rules);
  const least = rules.credential_like.key_value_min_length;
  const walk = (inner, key) => {
    if (typeof inner === 'string') return credentialPatterns.some(pattern => pattern.test(inner)) || (key !== null && credentialKey.test(key) && inner.length >= least && !/\s/.test(inner));
    if (Array.isArray(inner)) return inner.some(item => walk(item, key));
    if (object(inner)) return Object.entries(inner).some(([name, item]) => walk(item, name));
    return false;
  };
  return walk(value, null);
}

/** Whether a shell call's result proves its writes: true, false (refused) or null (cannot tell). */
export function shellSucceeded({ output, failed, invocations, command }, rules = settings) {
  if (failed) return false;
  const text = String(output ?? '');
  const proofs = rules.succeeded_words.reduce((sum, word) => sum + text.split(word).length - 1, 0);
  if (proofs >= invocations) return true;
  const projected = compiled(rules).projections.some(pattern => pattern.test(command ?? ''));
  if (projected && text.split('\n').filter(line => /^\s*(true|[1-9]\d*)\s*$/.test(line)).length >= invocations) return true;
  if (rules.refused_words.some(word => text.includes(word))) return false;
  return null;
}

/** The text of a result content: a string, or the text parts of a content list. */
const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '')).join('\n') : '');

/** The records of one records:write input, each { id, type, value }, or a problem. `expected` is dropped (a replay
 *  writes the value a call carried, not the condition it was written under); `conditioned` says it had one. */
export function recordsOf(input) {
  if (!object(input) || !Array.isArray(input.records) || !input.records.length) return { problem: 'no_records' };
  const records = [];
  for (const row of input.records) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || !('value' in row)) return { problem: 'record_without_id_or_value' };
    if (row.value !== null && (typeof row.type !== 'string' || !row.type)) return { problem: 'record_without_type' };
    records.push({ id: row.id, ...(typeof row.type === 'string' ? { type: row.type } : {}), value: row.value, ...(row.expected !== undefined ? { conditioned: true } : {}) });
  }
  return { records };
}

/** The input a shell call sent, read: { input } or { problem }. A file is read from disk only when it is unchanged since
 *  the call answered (its modification time is at or before the result's time). */
function inputOfShell(row, { answeredAt, stat, read }) {
  if (row.input.problem) return { problem: row.input.problem };
  let text = row.input.text;
  if (text === undefined) {
    let info;
    try { info = stat(row.input.file); } catch { return { problem: 'file_gone' }; }
    if (!Number.isFinite(answeredAt) || info.mtimeMs > answeredAt) return { problem: 'file_changed_after_call' };
    try { text = read(row.input.file, 'utf8'); } catch { return { problem: 'file_unreadable' }; }
  }
  try { return { input: JSON.parse(text) }; } catch { return { problem: 'input_not_json' }; }
}

/** Reads one transcript's lines (any iterable, sync or async) and reports each records:write call through `keep(call)`:
 *  { file, call_id, at, answered_at, form, from, records } when it succeeded, or { file, call_id, at, form, skipped,
 *  ids? } when it did not or cannot be told. A call id already in `seen` is skipped: a resumed or forked session carries
 *  its parent's rows again. A line that is not JSON is counted in `counts.unreadable_lines` and passed over. */
export async function readTranscript(lines, { host, file = null, keep, seen = new Set(), counts = {}, rules = settings, stat = statSync, read = readFileSync, home = homedir() }) {
  const shape = rules.shapes.message_parts, items = rules.shapes.completed_items;
  const files = new Map(), pending = new Map();
  const needles = [rules.line_needle, ...[...shape.file_write.names, ...shape.file_edit.names].map(name => `"name":"${name}"`), `"${items.file_change.item_type}"`];
  const resultNeedle = `"${shape.result.part_type}"`;
  const count = name => { counts[name] = (counts[name] ?? 0) + 1; };
  const pathOf = (raw, cwd) => { const path = host.expand(String(raw), home); return isAbsolute(path) ? resolve(path) : cwd ? resolve(cwd, path) : null; };
  const settle = (call, { succeeded, answeredAt, output }) => {
    if (call.shell) {
      const ok = succeeded ?? shellSucceeded({ output, failed: false, invocations: call.shell.length, command: call.command }, rules);
      for (const row of call.shell) {
        const base = { file, call_id: `${call.id}#${row.order}`, at: call.at, form: 'shell' };
        if (ok !== true) { keep({ ...base, skipped: ok === false ? 'refused' : 'result_unknown' }); continue; }
        const got = inputOfShell(row, { answeredAt, stat, read });
        const records = got.input === undefined ? got : recordsOf(got.input);
        keep(records.records ? { ...base, answered_at: answeredAt, records: records.records, from: row.input.from ?? (row.input.file ? 'disk' : 'command') } : { ...base, skipped: records.problem });
      }
      return;
    }
    const base = { file, call_id: call.id, at: call.at, form: 'operation' };
    if (succeeded !== true) { keep({ ...base, skipped: succeeded === false ? 'refused' : 'result_unknown', ...(call.records ? { ids: call.records.map(row => row.id) } : {}) }); return; }
    keep(call.records ? { ...base, answered_at: answeredAt, records: call.records, from: 'call' } : { ...base, skipped: call.problem });
  };
  for await (const line of lines) {
    if (!line) continue;
    const wanted = needles.some(needle => line.includes(needle))
      || (pending.size > 0 && line.includes(resultNeedle) && [...pending.keys()].some(id => line.includes(id)));
    if (!wanted) continue;
    let row;
    try { row = JSON.parse(line); } catch { count('unreadable_lines'); continue; }
    const parts = at(row, shape.parts_path);
    if (Array.isArray(parts)) {
      const time = millis(at(row, shape.time_path));
      const cwd = at(row, shape.cwd_path) ?? null;
      for (const part of parts) {
        if (part?.type === shape.call.part_type) {
          const id = at(part, shape.call.id_path), name = String(at(part, shape.call.name_path) ?? ''), input = at(part, shape.call.input_path);
          if (!object(input)) continue;
          if (shape.file_write.names.includes(name)) {
            const path = pathOf(at(input, shape.file_write.path_path) ?? '', cwd);
            const content = at(input, shape.file_write.content_path);
            if (path) files.set(path, { content: typeof content === 'string' ? content : null });
            continue;
          }
          if (shape.file_edit.names.includes(name)) {
            const path = pathOf(at(input, shape.file_edit.path_path) ?? '', cwd);
            if (!path) continue;
            const before = files.get(path)?.content, old = at(input, shape.file_edit.old_path), now = at(input, shape.file_edit.new_path);
            const edited = typeof before === 'string' && typeof old === 'string' && typeof now === 'string' && before.includes(old)
              ? (at(input, shape.file_edit.all_path) === true ? before.split(old).join(now) : before.replace(old, () => now)) : null;
            files.set(path, { content: edited });
            continue;
          }
          if (typeof id !== 'string') continue;
          const operation = name.endsWith(rules.write.tool_suffix) && input.method === rules.write.method && (input.address ?? rules.write.address) === rules.write.address;
          const command = shape.shell.names.includes(name) ? at(input, shape.shell.command_path) : null;
          const shell = typeof command === 'string' && command.includes(rules.line_needle) ? shellWrites(command, { host, cwd, files, home, rules }) : [];
          if (!operation && !shell.length) continue;
          if (seen.has(id)) { count('repeated_calls'); continue; }
          seen.add(id);
          pending.set(id, operation ? { id, at: time, ...recordsOf(input.input) } : { id, at: time, shell, command });
        } else if (part?.type === shape.result.part_type && pending.has(at(part, shape.result.id_path))) {
          const call = pending.get(at(part, shape.result.id_path));
          pending.delete(call.id);
          const output = textOf(at(part, shape.result.content_path));
          const failed = at(part, shape.result.error_path) === true;
          if (call.shell) settle(call, { succeeded: failed ? false : null, answeredAt: time, output });
          else settle(call, { succeeded: failed || /"isError"\s*:\s*true/.test(output) ? false : rules.succeeded_words.some(word => output.includes(word)) ? true : null, answeredAt: time });
        }
      }
      continue;
    }
    if (at(row, items.when_type_path) !== items.when_type) continue;
    const item = at(row, items.item_path);
    if (!object(item)) continue;
    const type = at(item, items.item_type_path), id = at(item, items.id_path);
    const answeredAt = millis(at(row, items.time_path));
    const started = at(row, items.started_ms_path);
    const time = Number.isFinite(started) ? started : answeredAt;
    if (type === items.file_change.item_type) {
      for (const [path, change] of Object.entries(at(item, items.file_change.changes_path) ?? {})) {
        const full = pathOf(path, null);
        if (full) files.set(full, { content: change?.type === 'add' && typeof change.content === 'string' ? change.content : null });
      }
      continue;
    }
    if (typeof id !== 'string') continue;
    if (type === items.operation.item_type) {
      const args = at(item, items.operation.arguments_path);
      if (!String(at(item, items.operation.tool_path) ?? '').endsWith(rules.write.tool_suffix) || !object(args) || args.method !== rules.write.method || (args.address ?? rules.write.address) !== rules.write.address) continue;
      if (seen.has(id)) { count('repeated_calls'); continue; }
      seen.add(id);
      const succeeded = at(item, items.operation.status_path) === items.operation.succeeded_status && at(item, items.operation.error_path) !== true;
      settle({ id, at: time, ...recordsOf(args.input) }, { succeeded, answeredAt });
    } else if (type === items.shell.item_type) {
      const argv = at(item, items.shell.command_path);
      const command = Array.isArray(argv)
        ? (rules.shells.includes(basename(String(argv[0]))) && /^-\w*c\w*$/.test(String(argv[1])) ? String(argv[2] ?? '') : argv.map(arg => `'${String(arg).replaceAll("'", "'\\''")}'`).join(' '))
        : String(argv ?? '');
      if (!command.includes(rules.line_needle)) continue;
      const rawCwd = at(item, items.shell.cwd_path);
      const cwd = typeof rawCwd === 'string' ? (rawCwd.startsWith('file:') ? fileURLToPath(rawCwd) : rawCwd) : null;
      const shell = shellWrites(command, { host, cwd, files, home, rules });
      if (!shell.length) continue;
      if (seen.has(id)) { count('repeated_calls'); continue; }
      seen.add(id);
      const exit = at(item, items.shell.exit_path);
      settle({ id, at: time, shell, command }, { succeeded: Number.isInteger(exit) && exit !== 0 ? false : null, answeredAt, output: at(item, items.shell.output_path) });
    }
  }
  for (const call of pending.values()) {
    if (call.shell) for (const row of call.shell) keep({ file, call_id: `${call.id}#${row.order}`, at: call.at, form: 'shell', skipped: 'no_result' });
    else keep({ file, call_id: call.id, at: call.at, form: 'operation', skipped: 'no_result', ...(call.records ? { ids: call.records.map(row => row.id) } : {}) });
  }
}

// ── The inventory ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every transcript file under each AI app's transcript folder (`transcript_roots`, or `roots`) changed at or after
 *  `since`: `subfolder` of the app's own folder, which is the command's `skills` row for that app (its home variable
 *  when set, else its folder under the home directory). */
export function transcriptFiles({ host, since, rules = settings, env = process.env, home = homedir(), roots = rules.transcript_roots }) {
  const found = [], read = [];
  const apps = new Map(host.settings.skills.map(row => [row.id, row]));
  const walk = (folder, depth) => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(rules.suffix)) {
        let info;
        try { info = statSync(path); } catch { continue; }
        if (info.mtimeMs >= since) found.push({ path, size: info.size });
      }
    }
  };
  for (const root of roots) {
    const app = apps.get(root.app);
    if (!app) throw new Error(`No skills row names the app ${root.app}, so where its transcripts are is unknown.`);
    const folder = join(app.home_variable && env[app.home_variable] ? env[app.home_variable] : join(home, app.folder), root.subfolder);
    read.push({ app: root.app, folder });
    walk(folder, rules.walk_depth);
  }
  return { files: [...new Map(found.map(file => [file.path, file])).values()].sort((a, b) => a.path.localeCompare(b.path)), roots: read };
}

const linesOf = path => createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });

/** The inventory of every records:write the transcripts prove, newest write per record id: { kept, conflicts, skipped,
 *  credential_like, types, counts }. `open` gives a file's lines. */
export async function inventoryOf({ host, files, since, open = linesOf, rules = settings, stat = statSync, read = readFileSync, home = homedir() }) {
  const newest = new Map(), history = new Map(), skipped = [];
  const counts = { files_read: 0, calls_kept: 0, calls_before_since: 0, records_written: 0 };
  const seen = new Set();
  let order = 0;
  for (const { path } of files) {
    counts.files_read += 1;
    await readTranscript(open(path), { host, file: path, seen, counts, rules, stat, read, home, keep: call => {
      if (Number.isFinite(call.at) && call.at < since) { counts.calls_before_since += 1; return; }
      if (call.skipped) { skipped.push(call); counts[`skipped_${call.skipped}`] = (counts[`skipped_${call.skipped}`] ?? 0) + 1; return; }
      counts.calls_kept += 1;
      for (const record of call.records) {
        counts.records_written += 1;
        const entry = { record, at: call.at, order: order += 1, file: call.file, call_id: call.call_id };
        const before = newest.get(record.id);
        if (!before || entry.at > before.at || (entry.at === before.at && entry.order > before.order)) newest.set(record.id, entry);
        const versions = history.get(record.id) ?? [];
        versions.push({ at: entry.at, value: canonical(record.value), file: call.file, call_id: call.call_id, removal: record.value === null });
        history.set(record.id, versions);
      }
    } });
  }
  const kept = [], credential = [];
  for (const entry of [...newest.values()].sort((a, b) => (a.record.type ?? '').localeCompare(b.record.type ?? '') || a.record.id.localeCompare(b.record.id))) {
    if (entry.record.value !== null && credentialLike(entry.record.value, rules)) { credential.push({ id: entry.record.id, type: entry.record.type, at: entry.at }); continue; }
    kept.push(entry);
  }
  const conflicts = [...history.entries()].flatMap(([id, versions]) => {
    const distinct = new Set(versions.map(row => row.value));
    if (distinct.size < 2) return [];
    const ordered = versions.sort((a, b) => a.at - b.at);
    return [{ id, type: newest.get(id).record.type ?? null, versions: ordered.length, distinct_values: distinct.size, kept: localTime(newest.get(id).at),
      each: ordered.map(row => ({ at: localTime(row.at), removal: row.removal, file: row.file, call_id: row.call_id })) }];
  });
  const types = {};
  for (const entry of kept) {
    const row = types[entry.record.type ?? '(removal without type)'] ??= { records: 0, removals: 0, first_ms: Infinity, last_ms: -Infinity };
    if (entry.record.value === null) row.removals += 1; else row.records += 1;
    row.first_ms = Math.min(row.first_ms, entry.at);
    row.last_ms = Math.max(row.last_ms, entry.at);
  }
  for (const row of Object.values(types)) { row.first = localTime(row.first_ms); row.last = localTime(row.last_ms); delete row.first_ms; delete row.last_ms; }
  return { kept, conflicts, skipped, credential_like: credential, types, counts };
}

const stampOf = now => {
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
};

/** The folder inventories are written in: `inventory_beside_state` beside the command's own state folder. */
export const inventoryFolder = (host, home = homedir(), rules = settings) => join(dirname(host.expand(host.settings.state_folder, home)), rules.inventory_beside_state);

/** The dry run: reads every transcript, writes the inventory folder (summary.json, records.jsonl, conflicts.jsonl,
 *  skipped.jsonl, credential-like.json, each readable only by this user) and answers the summary. Nothing is sent. */
export async function dryRun({ host, since, rules = settings, home = homedir(), env = process.env, now = new Date(), roots = rules.transcript_roots, folder = null }) {
  const sinceMs = millis(since);
  if (!Number.isFinite(sinceMs)) throw new Error('The earliest call time is a time, for example 2026-01-31T00:00:00Z.');
  const found = transcriptFiles({ host, since: sinceMs, rules, env, home, roots });
  const inventory = await inventoryOf({ host, files: found.files, since: sinceMs, rules, home });
  const out = folder ?? join(inventoryFolder(host, home, rules), stampOf(now));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const jsonl = rows => rows.map(row => `${JSON.stringify(row)}\n`).join('');
  const put = (name, text) => writeFileSync(join(out, name), text, { mode: 0o600 });
  put('records.jsonl', jsonl(inventory.kept.map(({ record }) => ({ id: record.id, ...(record.type ? { type: record.type } : {}), value: record.value }))));
  put('conflicts.jsonl', jsonl(inventory.conflicts));
  put('skipped.jsonl', jsonl(inventory.skipped.map(row => ({ ...row, at: Number.isFinite(row.at) ? localTime(row.at) : null }))));
  put('credential-like.json', `${JSON.stringify(inventory.credential_like.map(row => ({ ...row, at: localTime(row.at) })), null, 2)}\n`);
  const summary = {
    inventory: out, made: localTime(now.getTime()), since: localTime(sinceMs), roots: found.roots,
    transcripts: found.files.length, counts: inventory.counts,
    records: { kept: inventory.kept.filter(entry => entry.record.value !== null).length, removals: inventory.kept.filter(entry => entry.record.value === null).length,
      conditioned_writes_kept: inventory.kept.filter(entry => entry.record.conditioned).length, credential_like: inventory.credential_like.length },
    conflicts: inventory.conflicts.length, types: inventory.types,
  };
  put('summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// ── Writing an inventory back ────────────────────────────────────────────────────────────────────────────────────

/** Records in batches of at most `max_records` whose JSON stays within `max_bytes`; a record larger than that goes
 *  alone (the door answers for it). */
export function batchesOf(records, { max_records: most, max_bytes: bytes } = settings.batch) {
  const batches = [];
  let batch = [], size = 0;
  for (const record of records) {
    const length = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (batch.length && (batch.length >= most || size + length > bytes)) { batches.push(batch); batch = []; size = 0; }
    batch.push(record);
    size += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const rowsOf = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

/** Writes one inventory's records through records:write (`client.op`), batch by batch, each with its own request key
 *  (`<prefix>-<folder name>-<n>`); batches written.jsonl says were answered are not sent again. Then reads back up to
 *  `readback.per_type` records of each type (the first, middle and last by id) and compares each value with what was
 *  written; a removal reads back as no value. Answers and keeps (readback.json) { batches, written, failed, readback }. */
export async function writeInventory(client, folder, { rules = settings, now = () => new Date() } = {}) {
  const records = rowsOf(join(folder, 'records.jsonl'));
  const log = join(folder, 'written.jsonl');
  const done = new Set(existsSync(log) ? rowsOf(log).filter(row => row.answer).map(row => row.batch) : []);
  const batches = batchesOf(records, rules.batch);
  let written = 0;
  const failed = [];
  for (const [index, batch] of batches.entries()) {
    const number = index + 1;
    if (done.has(number)) { written += batch.length; continue; }
    const requestKey = `${rules.batch.request_key_prefix}-${basename(folder)}-${number}`;
    const row = { batch: number, records: batch.length, first: batch[0].id, last: batch.at(-1).id };
    try {
      const answer = await client.op(rules.write.address, rules.write.method, { records: batch }, { idempotent: true, requestKey });
      written += batch.length;
      appendFileSync(log, `${JSON.stringify({ ...row, answer: { changed: answer?.changed ?? null, write_count: answer?.write_count ?? null }, at: now().toISOString() })}\n`);
    } catch (error) {
      failed.push({ ...row, code: error.code ?? null, why: error.message });
      appendFileSync(log, `${JSON.stringify({ ...row, failed: error.message, code: error.code ?? null, at: now().toISOString() })}\n`);
    }
  }
  const byType = new Map();
  for (const record of records) byType.set(record.type ?? null, [...(byType.get(record.type ?? null) ?? []), record]);
  const readback = [];
  for (const [type, rows] of byType) {
    const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const picks = [...new Set([0, Math.floor((sorted.length - 1) / 2), sorted.length - 1])].slice(0, rules.readback.per_type).map(place => sorted[place]);
    for (const record of picks) {
      let value = null, why = null;
      try { value = (await client.op(rules.write.address, rules.readback.method, { id: record.id, ...(type ? { type } : {}) }, { idempotent: true }))?.value ?? null; }
      catch (error) { why = error.code ?? error.message; }
      readback.push({ id: record.id, type, same: canonical(value) === canonical(record.value), ...(why && record.value !== null ? { why } : {}) });
    }
  }
  const result = { inventory: folder, batches: batches.length, written, failed,
    readback: { read: readback.length, same: readback.filter(row => row.same).length, different: readback.filter(row => !row.same) } };
  writeFileSync(join(folder, 'readback.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}
