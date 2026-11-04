// tools/type-what-i-say/read-data/dictation.mjs
//
// Purpose
//   Dictation text for this Mac: the words a hearing program returns for a spoken sentence become clean text for the
//   app the person is in, the recognition is biased by their dictionary and what surrounds the cursor, the text is put
//   at the cursor as one clipboard transaction (save, write, paste, restore, verify), and the edits the person makes
//   afterwards teach their dictionary. It is tool:dictate and tool:type-dictated-text, run on the person's computer as
//     node /opt/records-door/do-work/run-an-export.mjs /opt/type-what-i-say/read-data/dictation.mjs dictate|typeDictatedText
//   with { input, folder } on standard input, `folder` the folder the person granted for their rows and history. It holds
//   the push-to-talk / hands-free key table; the key events themselves come from the Mac app's native layer.
//
// Non-negotiable invariants
//   1. Every step, spoken command, style, command line and word is DATA (read-data/dictation.json). The person's own
//      dictionary and snippets are rows in their rows file; this file names no app, no word and no program.
//   2. Cleaning is pure and in the order `pipeline` says; an unknown step is skipped and reported, never silently
//      changing the text. Dictionary terms keep the case their row gives (style runs before the dictionary).
//   3. Putting text in an app is one transaction that restores the clipboard whenever it saved it (`finally`), says
//      every stage's outcome (saved, wrote, pasted, restored, verified), and never pastes over a clipboard that holds
//      something it cannot put back as text.
//   4. A change in the person's edit teaches only short word replacements (learn.most_words); one seen `promote_after`
//      times becomes an active dictionary row, so one slip never rewrites later dictation. A row the person taught
//      themselves is never overwritten by learning.
//   5. A held key is stopped when the native layer says it is no longer down, or after keys.most_seconds, so a lost
//      key-up never leaves the microphone recording.
//   6. Row ids are BLAKE3 of the row's identity, never SHA-256.
//   7. Each dictation is one entry with an id made when it starts and carried through cleaning, inserting and learning;
//      its outcome is a typed word (inserted-verified, inserted-unverified, blocked, failed), never a bare boolean.
//   8. What is kept about dictations (dictation.json `history`) is bounded by days and count, and the person can list and
//      erase it; nothing else of what they said is kept here.
//
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** BLAKE3-256 of the bytes as 64 hex digits, from the one content-identity owner (its `1f:` prefix dropped). */
const blake3Hex = bytes => makeHashCodeHexFromBytes(bytes).slice(3);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsIn = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
const edge = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const norm = word => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export const dictationSettings = () => JSON.parse(readFileSync(path.join(HERE, 'dictation.json'), 'utf8'));
/** A new entry id: BLAKE3 of a random value and the time, so it names one dictation and nothing about its words. */
export const newEntryId = (now = Date.now()) => blake3Hex(new TextEncoder().encode(`${crypto.randomUUID()}:${now}`)).slice(0, 16);
export const rowId = (kind, phrase) => blake3Hex(new TextEncoder().encode(JSON.stringify([kind, String(phrase).toLowerCase().trim()]))).slice(0, 16);

// ---- The person's rows ---------------------------------------------------------------------------------------------

const rowsPath = settings => path.join(expand(settings.state), settings.rows_file);
export function readRows(settings, read = file => readFileSync(file, 'utf8')) {
  try { const { rows } = JSON.parse(read(rowsPath(settings))); return Array.isArray(rows) ? rows : []; } catch { return []; }
}
export function writeRows(settings, rows, write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.part`, text, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}) {
  write(rowsPath(settings), `${JSON.stringify({ rows }, null, 1)}\n`);
  return rows;
}

// ---- Cleaning: the pipeline ----------------------------------------------------------------------------------------

const boundary = phrase => `(?<![\\p{L}\\p{N}])${escapeRegex(phrase).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`;
// A phrase as a recogniser writes it: whole words, in any case, with the punctuation it hung on the end.
const spoken = phrase => new RegExp(`${boundary(phrase)}[.,!?]?`, 'giu');

const dropPreviousSentence = text => {
  const trimmed = text.replace(/\s+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('. '), trimmed.lastIndexOf('! '), trimmed.lastIndexOf('? '), trimmed.lastIndexOf('\n'));
  return cut < 0 ? '' : trimmed.slice(0, cut + 1);
};

/** One step of the pipeline: (text, { settings, rows, context }) -> text. A step id not here is skipped and said. */
export const steps = {
  'spoken-commands'(text, { settings }) {
    let out = text;
    for (const command of settings.spoken_commands ?? []) {
      for (const phrase of command.says) {
        if (command.does === 'drop-previous-sentence') {
          const found = spoken(phrase).exec(out);
          if (found) out = dropPreviousSentence(out.slice(0, found.index)) + out.slice(found.index + found[0].length);
        } else out = out.replace(new RegExp(`\\s*${boundary(phrase)}[.,!?]?\\s*`, 'giu'), () => command.insert ?? '');
      }
    }
    return out;
  },
  style(text, { settings, context }) {
    const app = String(context?.app ?? '').toLowerCase();
    const styles = settings.styles ?? [];
    const style = styles.find(row => row.when?.app_contains?.some(part => app.includes(String(part).toLowerCase()))) ?? styles.find(row => !row.when);
    let out = text;
    if (style?.case === 'lower') out = out.toLowerCase();
    if (style?.end_period === 'strip') out = out.replace(/\.\s*$/, '');
    return out;
  },
  dictionary(text, { rows }) {
    return rows.filter(row => row.kind === 'dictionary' && row.active !== false && row.from && row.to != null)
      .sort((a, b) => b.from.length - a.from.length)
      .reduce((out, row) => out.replace(new RegExp(boundary(row.from), 'giu'), () => row.to), text);
  },
  snippets(text, { rows }) {
    return rows.filter(row => row.kind === 'snippet' && row.says && row.expands_to != null)
      .sort((a, b) => b.says.length - a.says.length)
      .reduce((out, row) => out.replace(new RegExp(boundary(row.says), 'giu'), () => row.expands_to), text);
  },
  trim: text => text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim(),
};

/** The dictated text cleaned for the app in `context.app`: { text, applied: [step ids], skipped: [step ids] }. */
export function clean(text, { settings = dictationSettings(), rows = [], context = {} } = {}) {
  const applied = []; const skipped = [];
  let out = String(text ?? '');
  for (const id of settings.pipeline ?? []) {
    if (!Object.hasOwn(steps, id)) { skipped.push(id); continue; }
    out = steps[id](out, { settings, rows, context }); applied.push(id);
  }
  return { text: out, applied, skipped };
}

// ---- Biasing what is heard -----------------------------------------------------------------------------------------

/**
 * The words that may come up, as the hearing program's prompt: the dictionary's targets, then the names the caller found
 * around the cursor (`context.names`: list or people names), then the app name, then the capitalised words of whatever
 * screen text the caller chose to give (`context.screen_text`; this reads no screen itself). Cut to bias.most_words and most_characters.
 */
export function biasPrompt({ settings = dictationSettings(), rows = [], context = {} } = {}) {
  const seen = new Set(); const words = [];
  const add = word => { const key = word.toLowerCase(); if (word && !seen.has(key)) { seen.add(key); words.push(word); } };
  rows.filter(row => row.kind === 'dictionary' && row.active !== false).forEach(row => add(String(row.to)));
  (context.names ?? []).forEach(name => add(String(name)));
  if (context.app) add(String(context.app));
  (String(context.screen_text ?? '').match(/\b\p{Lu}[\p{L}\p{N}]{2,}\b/gu) ?? []).forEach(add);
  const build = list => (list.length ? fill(settings.bias?.template, { words: list.join(', ') }) : '');
  let kept = words.slice(0, settings.bias?.most_words ?? 40);
  while (kept.length && build(kept).length > (settings.bias?.most_characters ?? 220)) kept = kept.slice(0, -1);
  return build(kept);
}

// ---- Learning from the person's edit ------------------------------------------------------------------------------

/** The replaced spans between what was inserted and what the person left: [{ from, to }], each side at most `most` words. */
export function wordChanges(inserted, final, most = 4) {
  const a = wordsIn(inserted); const b = wordsIn(final);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = norm(a[i]) === norm(b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const changes = []; let from = []; let to = [];
  const flush = () => {
    const was = from.join(' ').replace(edge, ''); const now = to.join(' ').replace(edge, '');
    if (from.length && to.length && from.length <= most && to.length <= most && was !== now) changes.push({ from: was, to: now });
    from = []; to = [];
  };
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && norm(a[i]) === norm(b[j])) { flush(); i += 1; j += 1; }
    else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) { from.push(a[i]); i += 1; }
    else { to.push(b[j]); j += 1; }
  }
  flush();
  return changes;
}

/** Rows after seeing `changes` once more: a seen change counts up and turns active at learn.promote_after; the least-seen go past learn.most_rows. */
export function learnChanges(rows, changes, settings = dictationSettings(), now = new Date()) {
  const next = rows.map(row => ({ ...row }));
  for (const change of changes) {
    const id = rowId('dictionary', `${change.from}\u0000${change.to}`);
    const found = next.find(row => row.id === id);
    if (next.some(row => row.kind === 'dictionary' && row.taught && row.from?.toLowerCase() === change.from.toLowerCase())) continue;
    if (found) { found.count = (found.count ?? 1) + 1; found.seen_at = now.toISOString(); if (found.count >= settings.learn.promote_after) found.active = true; }
    else next.push({ id, kind: 'dictionary', from: change.from, to: change.to, count: 1, active: settings.learn.promote_after <= 1, learned: true, seen_at: now.toISOString() });
  }
  return next.sort((a, b) => (b.active === true) - (a.active === true) || (b.count ?? 0) - (a.count ?? 0)).slice(0, settings.learn.most_rows);
}

// ---- Putting text in the app ---------------------------------------------------------------------------------------

const defaultRun = (argv, input = '', seconds = 10) => new Promise((resolve, reject) => {
  const child = execFile(argv[0], argv.slice(1), { timeout: seconds * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  child.stdin.end(input);
});

// The data kinds `clipboard info` lists ("«class utf8», 12, string, 12, ..."): the words that are not counts.
const kindsOf = listing => String(listing).split(',').map(part => part.trim().replace(/^«class\s*|»$/g, '').toLowerCase()).filter(part => part && !/^\d+$/.test(part));

/**
 * Puts `text` where the cursor is, as one clipboard transaction through the commands of settings.insert (DATA):
 * save the clipboard text, write the text, paste, restore. Returns { saved, wrote, pasted, restored, verified, error }
 * (verified: true / false, or null when there is no verify command or it cannot read the field). The clipboard is
 * restored even when the paste fails; a clipboard holding something that is not text is left alone and nothing is pasted.
 */
export async function insertText(text, { settings = dictationSettings(), run = defaultRun, pause = ms => new Promise(done => setTimeout(done, ms)), entryId = newEntryId() } = {}) {
  const insert = settings.insert;
  const outcome = { entry_id: entryId, kind: 'failed', saved: false, wrote: false, pasted: false, restored: false, verified: null, error: null };
  let before = '';
  try {
    const other = kindsOf(await run(insert.clipboard_kinds).catch(() => '')).filter(kind => !insert.text_kinds.some(known => kind.includes(known)));
    if (other.length) { outcome.error = fill(settings.words.non_text_clipboard, { kinds: other.join(', ') }); outcome.kind = 'blocked'; return outcome; }
    before = await run(insert.save); outcome.saved = true;
    await run(insert.write, text); outcome.wrote = true;
    await run(insert.paste); outcome.pasted = true;
    await pause(insert.settle_ms);
    if (insert.verify) outcome.verified = await run(insert.verify).then(field => field.includes(text.trim()), () => null);
  } catch (error) { outcome.error = String(error.message ?? error); } finally {
    if (outcome.saved) await run(insert.restore, before).then(() => { outcome.restored = true; }, error => { outcome.error ??= `restoring the clipboard: ${error.message}`; });
    if (outcome.kind !== 'blocked') outcome.kind = outcome.pasted ? (outcome.verified === true ? 'inserted-verified' : 'inserted-unverified') : 'failed';
  }
  return outcome;
}

// ---- Keys: push-to-talk and hands-free -----------------------------------------------------------------------------

/**
 * The key table (settings.keys: { <action>: { mode: 'hold' | 'toggle' }, most_seconds }) as a machine. event(action,
 * 'down' | 'up') starts and stops through `handlers.start(action)` / `handlers.stop(action, reason)`; tick() stops a
 * held action the native layer (`stillDown(action)`) says is no longer down, and any action running past most_seconds.
 */
export function keyMachine(keys, handlers, { now = () => Date.now(), stillDown = () => true } = {}) {
  const running = new Map();
  const start = action => { if (!running.has(action)) { running.set(action, now()); handlers.start(action); } };
  const stop = (action, reason) => { if (running.delete(action)) handlers.stop(action, reason); };
  return {
    running: () => [...running.keys()],
    event(action, phase) {
      const mode = keys[action]?.mode;
      if (mode === 'hold') { if (phase === 'down') start(action); else stop(action, 'released'); }
      else if (mode === 'toggle' && phase === 'down') { if (running.has(action)) stop(action, 'toggled'); else start(action); }
    },
    tick() {
      for (const [action, since] of [...running]) {
        if (keys[action]?.mode === 'hold' && !stillDown(action)) stop(action, 'key-not-down');
        else if (now() - since > (keys.most_seconds ?? 300) * 1000) stop(action, 'too-long');
      }
    },
  };
}

// ---- What is kept about dictations ---------------------------------------------------------------------------------

const historyPath = settings => path.join(expand(settings.state), settings.history.file);
const readHistory = (settings, read = file => readFileSync(file, 'utf8')) => { try { const { entries } = JSON.parse(read(historyPath(settings))); return Array.isArray(entries) ? entries : []; } catch { return []; } };
const writeHistory = (settings, entries) => {
  const file = historyPath(settings);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.part`, `${JSON.stringify({ entries }, null, 1)}\n`, { mode: 0o600 });
  renameSync(`${file}.part`, file);
};

/** Notes one dictation in the history (text only while history.keep_text) and drops entries past keep_days and most. */
export function recordDictation(settings, { entry_id: id, app = null, text = '', kind }, now = Date.now()) {
  const keepMs = settings.history.keep_days * 86_400_000;
  const entries = readHistory(settings).filter(entry => now - entry.at <= keepMs && entry.entry_id !== id);
  entries.push({ entry_id: id, at: now, app, kind, ...(settings.history.keep_text ? { text } : {}) });
  writeHistory(settings, entries.slice(-settings.history.most));
  return entries.at(-1);
}

// ---- The tool on this Mac ------------------------------------------------------------------------------------------

const ACTIONS = ['clean', 'bias', 'learn', 'insert', 'add', 'list', 'edit', 'delete', 'history', 'erase'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * The two text steps that need a language model, each its own request with its own typed answer so the model can change without a
 * new build: 'polish' tidies the dictated words (settings.polish.words.polish), 'command' applies a spoken instruction to the text
 * (settings.polish.words.command). `ask` is askLocal bound to this computer's settings; the job id is DATA. A model that does not
 * answer, or answers something that is not the JSON object asked for, leaves the text exactly as it was (`changed: false`).
 */
export async function modelStep(kind, text, { settings = dictationSettings(), ask, instruction = '' }) {
  const words = settings.polish.words[kind];
  if (!words) throw fail(fill(settings.words.unknown_step, { step: kind }));
  const reply = await ask({ job: settings.polish.job, temperature: 0, max_tokens: settings.polish.most_tokens, messages: [
    { role: 'system', content: words.system },
    { role: 'user', content: fill(words.ask, { text, instruction }) },
  ] });
  try {
    const answer = JSON.parse(reply?.choices?.[0]?.message?.content ?? '');
    if (typeof answer?.text === 'string' && answer.text.trim()) return { text: answer.text.trim(), changed: answer.text.trim() !== text.trim(), model: reply.model ?? null };
  } catch { /* not the object asked for */ }
  return { text, changed: false, model: null, said: settings.words.model_silent };
}

export const dictationTools = {
  /** One tool, every action: clean | bias | learn | insert | add | list | edit | delete | history | erase. */
  async dictate(input, { run = defaultRun, settings = dictationSettings(), askModel = null } = {}) {
    const action = input.action ?? 'clean';
    const rows = readRows(settings);
    if (action === 'clean') {
      if (!String(input.text ?? '').trim()) throw fail(settings.words.no_text);
      const out = clean(input.text, { settings, rows, context: input.context ?? {} });
      if (input.polish || input.command) {
        // The Mac app's local model (computer/local-models.mjs) is not carried: without a model handed in, nothing answers
        // and the text is left as it was (modelStep's own rule).
        const ask = askModel ?? (async () => null);
        const stepped = input.command ? await modelStep('command', out.text, { settings, ask, instruction: String(input.command) }) : await modelStep('polish', out.text, { settings, ask });
        out.text = stepped.text; out.model = { changed: stepped.changed, said: stepped.said ?? null };
      }
      return { ...out, entry_id: input.entry_id ?? newEntryId(), notes: out.skipped.map(step => fill(settings.words.step_missing, { step })) };
    }
    if (action === 'bias') return { prompt: biasPrompt({ settings, rows, context: input.context ?? {} }) };
    if (action === 'learn') {
      const changes = wordChanges(input.inserted, input.final, settings.learn.most_words);
      writeRows(settings, learnChanges(rows, changes, settings));
      return { entry_id: input.entry_id ?? null, changes, said: fill(settings.words.learned, { count: changes.length }) };
    }
    if (action === 'insert') {
      if (!String(input.text ?? '').trim()) throw fail(settings.words.no_text);
      const outcome = await insertText(input.text, { settings, run, entryId: input.entry_id ?? newEntryId() });
      recordDictation(settings, { entry_id: outcome.entry_id, app: input.context?.app ?? null, text: input.text, kind: outcome.kind });
      return outcome;
    }
    if (action === 'list') return { rows };
    if (action === 'history') return { entries: readHistory(settings).filter(entry => Date.now() - entry.at <= settings.history.keep_days * 86_400_000) };
    if (action === 'erase') {
      const entries = readHistory(settings);
      const kept = input.entry_id ? entries.filter(entry => entry.entry_id !== input.entry_id) : [];
      if (input.entry_id && kept.length === entries.length) throw fail(fill(settings.words.no_entry, { id: input.entry_id }), 404);
      writeHistory(settings, kept);
      return { erased: entries.length - kept.length };
    }
    if (action === 'add') {
      const snippet = input.kind === 'snippet';
      if (!snippet && (!String(input.from ?? '').trim() || input.to == null)) throw fail(settings.words.needs_phrase);
      if (snippet && (!String(input.says ?? '').trim() || input.expands_to == null)) throw fail(settings.words.needs_says);
      const row = snippet
        ? { id: rowId('snippet', input.says), kind: 'snippet', says: String(input.says).trim(), expands_to: String(input.expands_to) }
        : { id: rowId('dictionary', `${String(input.from).trim()}\u0000${input.to}`), kind: 'dictionary', from: String(input.from).trim(), to: String(input.to), count: 1, active: true, taught: true };
      writeRows(settings, [...rows.filter(existing => existing.id !== row.id), row]);
      return { row };
    }
    if (!['edit', 'delete'].includes(action)) throw fail(fill(settings.words.unknown_action, { action, actions: ACTIONS.join(', ') }));
    const found = rows.find(row => row.id === input.id);
    if (!found) throw fail(fill(settings.words.no_row, { id: input.id }), 404);
    if (action === 'edit') {
      const edited = { ...found, ...Object.fromEntries(['from', 'to', 'says', 'expands_to', 'active'].filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
      writeRows(settings, rows.map(row => (row.id === found.id ? edited : row)));
      return { row: edited };
    }
    writeRows(settings, rows.filter(row => row.id !== found.id));
    return { deleted: found.id };
  },
};

// ---- The rows on the person's computer -----------------------------------------------------------------------------

const inFolder = folder => {
  const settings = dictationSettings();
  if (!String(folder ?? '').trim()) throw fail(settings.words.needs_folder);
  return { ...settings, state: folder };
};

/** tool:dictate: { input, folder } -> every action but insert, the person's rows and history kept in the granted folder. */
export async function dictate({ input = {}, folder } = {}) {
  const settings = inFolder(folder);
  if (input.action === 'insert') throw fail(settings.words.insert_elsewhere);
  return dictationTools.dictate(input, { settings });
}

/** tool:type-dictated-text: { input: { text, entry_id?, context? }, folder } -> the clipboard transaction's outcome. */
export async function typeDictatedText({ input = {}, folder } = {}) {
  return dictationTools.dictate({ ...input, action: 'insert' }, { settings: inFolder(folder) });
}
