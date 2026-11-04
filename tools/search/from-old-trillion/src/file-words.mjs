// src/file-words.mjs
//
// PURPOSE
//   The words written inside a person's files, read once and kept beside each file, so search (src/search.mjs) and
//   every AI find what a PDF, a Word or Excel file, a deck, a CSV or a text file says. Each readable file gets its
//   `contents` result ({ text, way, cut }), which search's word index reads (src/search.json lane `contents-words`)
//   and any AI reads with read_file_results. New files and files kept before this existed are read by the store's
//   alarm a few at a time.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which files are read and how is DATA (file-words.json rows); nothing here names a kind of file.
//   2. One file is held at a time, and each wake reads at most `catch_up.per_wake` files and looks at most
//      SCAN_ROWS rows past where it stopped, so a store with thousands of files never reads them all at once.
//   3. Nothing is guessed: a file whose reading fails is marked with the reason and tried again at most `tries`
//      times in all; one too large, or of no readable kind, is marked once and never read.
//   3a. Automatic reading is switchable: file-words.json `background_reading` (default true) and the caller's `reading()`
//      are both checked before any file is opened by the alarm, so an off switch is honoured before the document
//      reader is ever reached; reading one asked-for file (`read`) is not the alarm and is never refused by it.
//   4. The words never leave the person's account: the conversion runs on the account's own Workers AI binding, and
//      the result is kept in the person's own store.
//
import settings from './file-words.json' with { type: 'json' };

const IDENTITY = /^(1f|12):[0-9a-f]{64}$/;
// How many files past the cursor one wake looks at, readable or not (a store mostly of photos moves on quickly).
const SCAN_ROWS = 500;

/** The part of a name after its last dot, lower case; '' when there is none. */
const extensionOf = name => {
  const base = String(name ?? '').slice(String(name ?? '').lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

/** How a file with this media type and name is read ('as-text', 'converted'), or null when it is not read. */
export function wayOf({ media_type, name }, config = settings) {
  const type = String(media_type ?? '').split(';')[0].trim().toLowerCase();
  const named = !(config.unnamed_types ?? []).includes(type);
  const extension = extensionOf(name);
  const row = config.rows.find(candidate => (candidate.type_prefix !== undefined
    ? named && type.startsWith(candidate.type_prefix)
    : !named && (candidate.extensions ?? []).includes(extension)));
  return row?.way ?? null;
}

/**
 * The file-words owner in one person's store.
 *   sql        the person's store (namespace_files, namespace_names, namespace_results)
 *   open       identity -> { media_type, byte_length, stream() } (the person's namespace)
 *   keep       rows -> namespaceResults('put', rows), answering { refused? }
 *   ai         the account's Workers AI binding (toMarkdown), or null where none is reachable
 *   reading    () -> whether the person allows background reading now (default: yes)
 */
export function makeFileWords({ sql, open, keep, ai, reading = () => true, config = settings }) {
  const backgroundOn = () => config.background_reading !== false && reading() !== false;
  sql.exec('CREATE TABLE IF NOT EXISTS file_words_marks (identity TEXT PRIMARY KEY, tries INTEGER NOT NULL, said TEXT, at TEXT NOT NULL)');
  // The files still owed a try are the few with tries left: found by this index, never by walking every mark kept.
  sql.exec('CREATE INDEX IF NOT EXISTS file_words_marks_tries ON file_words_marks (tries)');
  sql.exec('CREATE TABLE IF NOT EXISTS file_words_cursor (name TEXT PRIMARY KEY, after INTEGER NOT NULL)');
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const cursor = () => all("SELECT after FROM file_words_cursor WHERE name = 'files'")[0]?.after ?? 0;
  const moveCursor = after => sql.exec("INSERT INTO file_words_cursor (name, after) VALUES ('files', ?) ON CONFLICT (name) DO UPDATE SET after = excluded.after", after);
  const mark = (identity, said, final) => sql.exec(
    'INSERT INTO file_words_marks (identity, tries, said, at) VALUES (?, ?, ?, ?) ON CONFLICT (identity) DO UPDATE SET tries = CASE WHEN ? THEN ? ELSE file_words_marks.tries + 1 END, said = excluded.said, at = excluded.at',
    identity, final ? config.catch_up.tries : 1, said, new Date().toISOString(), final ? 1 : 0, config.catch_up.tries);
  // A name of the file for its type: the first in the alphabet of the first 20 it was given (sorting every name of an
  // identity many names share read them all on every call, 2026-10-08).
  const nameOf = identity => all('SELECT MIN(name) AS name FROM (SELECT name FROM namespace_names WHERE identity = ? ORDER BY rowid LIMIT 20)', identity)[0]?.name ?? '';
  // A new isolate owes its first pass now. Starting from the Unix epoch makes scheduler aging
  // rank this work as decades overdue and can starve capacity recovery after every reset.
  let lastWake = Date.now() - config.catch_up.seconds_between_wakes * 1000;

  async function bytesOf(file, most) {
    const parts = [];
    let held = 0;
    for await (const part of await file.stream()) {
      const chunk = part instanceof Uint8Array ? part : new Uint8Array(part);
      parts.push(chunk.subarray(0, Math.max(0, most - held)));
      held += chunk.length;
      if (held >= most) break;
    }
    const whole = new Uint8Array(Math.min(held, most));
    let at = 0;
    for (const part of parts) { whole.set(part, at); at += part.length; }
    return whole;
  }

  async function wordsOf(file, way, name) {
    if (way === 'as-text') {
      const bytes = await bytesOf(file, config.text_bytes);
      return { text: new TextDecoder().decode(bytes), cut: file.byte_length > config.text_bytes };
    }
    if (!ai?.toMarkdown) throw new Error('No document reader is reachable here.');
    const bytes = await bytesOf(file, config.converted_bytes);
    const answer = await ai.toMarkdown({ name: name.slice(name.lastIndexOf('/') + 1) || 'file', blob: new Blob([bytes], { type: file.media_type || 'application/octet-stream' }) });
    const converted = Array.isArray(answer) ? answer[0] : answer;
    if (!converted || converted.format === 'error') throw new Error(converted?.error ?? 'The document could not be read.');
    return { text: String(converted.data ?? ''), cut: false };
  }

  /**
   * Reads one file's words and keeps them. Answers { identity, way, characters, cut } once read,
   * { identity, skipped, said } for a file that is not read, and throws when reading failed.
   */
  async function read(identity, { name = null } = {}) {
    if (typeof identity !== 'string' || !IDENTITY.test(identity)) throw new Error('Reading a file\'s words needs its identity.');
    const file = await open(identity);
    const called = name ?? nameOf(identity);
    const way = wayOf({ media_type: file.media_type, name: called }, config);
    if (!way) return { identity, skipped: true, said: 'Files of this kind have no words to read.' };
    const limit = way === 'converted' ? config.converted_bytes : Infinity;
    if (file.byte_length > limit) return { identity, skipped: true, said: 'This file is too large to read its words.' };
    const { text, cut } = await wordsOf(file, way, called);
    const kept = text.length > config.kept_characters ? text.slice(0, config.kept_characters) : text;
    const answer = await keep([{ identity, kind: 'contents', value: { text: kept, way, cut: cut || kept.length < text.length }, produced_by: 'tool:read-file-words' }]);
    if (answer?.refused?.length) throw new Error(`The words could not be kept: ${answer.refused[0].reason}`);
    return { identity, way, characters: kept.length, cut: cut || kept.length < text.length };
  }

  // Failed reads still owed another try, then files past the cursor, never reading more than per_wake files.
  const owed = () => all(`SELECT m.identity AS identity FROM file_words_marks m
    WHERE m.tries < ? AND NOT EXISTS (SELECT 1 FROM namespace_results r WHERE r.identity = m.identity AND r.kind = 'contents') LIMIT ?`,
  config.catch_up.tries, config.catch_up.per_wake);

  /**
   * Reads up to per_wake unread files; answers { read, skipped, failed, done }. `stage` is the scheduler's budget for
   * this run ({ left() }): once it is spent no further file is started and the cursor stays where the wake stopped.
   */
  async function catchUp(stage = null) {
    lastWake = Date.now();
    const answer = { read: 0, skipped: 0, failed: 0 };
    if (!backgroundOn()) return { ...answer, done: true, off: true };
    let budget = config.catch_up.per_wake;
    const spent = () => stage !== null && stage.left() <= 0;
    const attempt = async (identity, name) => {
      budget -= 1;
      try {
        const done = await read(identity, { name });
        if (done.skipped) { mark(identity, done.said, true); answer.skipped += 1; } else answer.read += 1;
      } catch (error) {
        mark(identity, error instanceof Error ? error.message : String(error), false);
        answer.failed += 1;
      }
    };
    for (const { identity } of owed()) if (budget > 0 && !spent()) await attempt(identity, null);
    let after = cursor();
    const rows = budget > 0 && !spent() ? all(`SELECT rowid AS at, identity, media_type FROM namespace_files WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, SCAN_ROWS) : [];
    // Most files (videos and pictures, for example) cannot have written words. Classify their media types before
    // asking for names or previous results. The remaining bounded page is resolved in one SQL statement instead of
    // one name query, and then one result query, for every candidate file.
    const unnamed = new Set(config.unnamed_types ?? []);
    const candidates = rows.filter(row => unnamed.has(String(row.media_type ?? '').split(';')[0].trim().toLowerCase())
      || wayOf({ media_type: row.media_type, name: '' }, config)).map(row => row.identity);
    const details = new Map((candidates.length ? all(`SELECT picked.value AS identity,
      (SELECT MIN(name) FROM (SELECT name FROM namespace_names WHERE identity = picked.value ORDER BY rowid LIMIT 20)) AS name,
      EXISTS (SELECT 1 FROM namespace_results WHERE identity = picked.value AND kind = 'contents') AS has_contents,
      EXISTS (SELECT 1 FROM file_words_marks WHERE identity = picked.value) AS has_mark
      FROM json_each(?) AS picked`, JSON.stringify(candidates)) : []).map(row => [row.identity, row]));
    for (const row of rows) {
      if (budget <= 0 || spent()) break;
      after = row.at;
      const detail = details.get(row.identity);
      if (!detail) continue;
      const name = detail.name ?? '';
      if (!wayOf({ media_type: row.media_type, name }, config)) continue;
      if (!detail.has_contents && !detail.has_mark) await attempt(row.identity, name);
    }
    if (rows.length) moveCursor(after);
    return { ...answer, done: !stale() };
  }

  /** Whether any file is still owed a reading: one past the cursor, or a failed one with tries left. */
  function stale() {
    if (all('SELECT 1 FROM namespace_files WHERE rowid > ? LIMIT 1', cursor()).length) return true;
    return all("SELECT 1 FROM file_words_marks m WHERE m.tries < ? AND NOT EXISTS (SELECT 1 FROM namespace_results r WHERE r.identity = m.identity AND r.kind = 'contents') LIMIT 1", config.catch_up.tries).length > 0;
  }

  /** When the alarm should next read, or null when nothing is owed. */
  const nextAt = () => (backgroundOn() && stale() ? lastWake + config.catch_up.seconds_between_wakes * 1000 : null);

  return { read, catchUp, stale, nextAt };
}
