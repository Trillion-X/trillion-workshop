// src/note-text-index.mjs
//
// PURPOSE
//   Checkbox tasks and nested #tags written inside note text, derived into two rebuildable index tables an AI or a
//   screen can query without reading every note: which tasks are open, which tags exist and how many notes carry each,
//   which notes carry a tag. A note is anything with an id and text (a sticky, a note on a file, a transcript the
//   person edited); the index is blind to what the note is and keeps only the id, its kind and its space so a reader
//   can navigate back to it. Mechanism from the Spatial.app reverse engineering (F-0832): `tasks(item_id, position,
//   line, text, done, kind, space_id)` and `tags(item_id, tag, display, explicit, kind, space_id)`.
//
//   Notes kept as file results (kinds named in DATA: `note`, `notes`, `markdown`; the text is the value itself, or its
//   `text`/`markdown`/`body` field) are indexed by `syncResults`, which reads only results whose value identity changed
//   since they were indexed and forgets results that are gone. Their item id is `result:<file identity>#<kind>`, so a
//   reader can open the same result with read_file_results.
//
//   note_text_sources  one row per indexed note: the BLAKE3 identity of the text indexed, so unchanged text is skipped
//   note_tasks         one row per checkbox paragraph, in the order written
//   note_tags          one row per tag a note carries, including every parent of a nested tag (explicit = 0)
//
//   Tasks: a paragraph that starts with a checkbox, `[ ]` open or `[x]` done, optionally behind a list marker.
//   Tags (Bear style): `#tag`, nested `#work/project` (the note also carries `work`), and `#multi word tag#`. Matching is
//   case-insensitive; `display` is the spelling first written in the note. A heading (`# Title`), a number alone
//   (`#12`) and anything inside a fenced code block or a code span is not a tag.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Derived, never authoritative: the note text is the only truth. `rebuild` drops both tables and indexes the notes
//      again, and the result equals indexing them one by one.
//   2. Incremental: indexing a note whose text is unchanged writes nothing; changed text replaces that note's rows in
//      one transaction; `remove` takes every row of a note away.
//   3. Every row carries the note's id (and space), so a reader can open the note a task or tag came from.
//   4. Patterns and limits are DATA (note-text-index.json); nothing here names an app, a note kind or a space.
//   5. Content identity is BLAKE3. The index holds the note's task and tag text, not its body, and is erased with it.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import settings from '../../shared-code/src/note-text-index.json' with { type: 'json' };

const TASK_LINE = new RegExp(settings.task_line);
const FENCE = new RegExp(settings.fence);
const sep = settings.tag_separator;
const word = settings.tag_chars;
const WRITTEN = `(?:${word}(?:${sep.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}${word}){0,${settings.tag_max_depth - 1}})`;
const CLOSE = settings.tag_multiword_close;
const TAG = new RegExp(`${settings.tag_start_boundary}#(?:([^\\s#](?:[^#\\n]{0,${settings.tag_max_chars}}[^\\s#])?)${CLOSE}(?![\\p{L}\\p{N}])|(${WRITTEN}))`, 'gu');
const CODE_SPAN = /`[^`\n]*`/g;
const oneLine = value => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value);
const identityOf = text => bytesToHex(blake3(utf8ToBytes(text)).slice(0, 16));
const lowered = value => value.toLocaleLowerCase();

/** The tags written on one line (outside code spans), as { display } in the order written. */
function tagsOfLine(line) {
  const found = [];
  for (const match of line.replace(CODE_SPAN, ' ').matchAll(TAG)) {
    const multi = match[1] !== undefined, written = (multi ? match[1] : match[2]).trim();
    if (!written || (multi && !/\s/.test(written)) || /^\d+$/.test(written) || written.length > settings.tag_max_chars) continue;
    found.push(written);
  }
  return found;
}

/** Every task and tag in a note's text. A tag lists itself (explicit) and each parent of its path (not explicit). */
export function parseNoteText(text) {
  const tasks = [], tags = new Map();
  let fenced = false;
  const keep = (display, explicit) => {
    const key = lowered(display);
    const held = tags.get(key);
    if (!held) tags.set(key, { tag: key, display, explicit });
    else if (explicit && !held.explicit) tags.set(key, { tag: key, display, explicit: true });
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const task = TASK_LINE.exec(line);
    if (task) tasks.push({ position: tasks.length, line: line.trimEnd(), text: task[2].trim(), done: task[1] !== ' ' });
    for (const written of tagsOfLine(task ? task[2] : line)) {
      keep(written, true);
      const path = written.split(sep);
      for (let depth = path.length - 1; depth >= 1; depth--) keep(path.slice(0, depth).join(sep), false);
    }
  }
  return { tasks, tags: [...tags.values()] };
}

/** The index over `sql` (a SQLite host as in src/local-store.mjs). `transaction` wraps a group of writes; by default none. */
export function noteTextIndex(sql, { transaction = work => work() } = {}) {
  sql.exec('CREATE TABLE IF NOT EXISTS note_text_sources (item_id TEXT PRIMARY KEY, identity TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS note_tasks (item_id TEXT NOT NULL, position INTEGER NOT NULL, line TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, kind TEXT NOT NULL, space_id TEXT NOT NULL, PRIMARY KEY (item_id, position))');
  sql.exec('CREATE TABLE IF NOT EXISTS note_tags (item_id TEXT NOT NULL, tag TEXT NOT NULL, display TEXT NOT NULL, explicit INTEGER NOT NULL, kind TEXT NOT NULL, space_id TEXT NOT NULL, PRIMARY KEY (item_id, tag))');
  sql.exec('CREATE INDEX IF NOT EXISTS note_tasks_by_state ON note_tasks (space_id, done, item_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS note_tags_by_tag ON note_tags (space_id, tag, item_id)');
  // reads-ok: every caller below is a LIMIT 1 point read, a LIMIT page (limited() caps it at max_list_limit) or a delete.
  const all = (query, ...args) => sql.exec(query, ...args).toArray();
  const limited = limit => Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, settings.max_list_limit) : settings.list_limit;
  const drop = itemId => { sql.exec('DELETE FROM note_tasks WHERE item_id = ?', itemId); sql.exec('DELETE FROM note_tags WHERE item_id = ?', itemId); sql.exec('DELETE FROM note_text_sources WHERE item_id = ?', itemId); };

  const index = ({ item_id: itemId, text, kind = 'note', space_id: spaceId = '', source_identity: sourceIdentity = null }) => {
    if (typeof itemId !== 'string' || !itemId || !oneLine(itemId)) throw new Error('A note is indexed under its id.');
    if (typeof text !== 'string' || text.length > settings.max_text_chars) throw new Error(`A note's text is at most ${settings.max_text_chars} characters.`);
    const identity = typeof sourceIdentity === 'string' && sourceIdentity ? sourceIdentity : identityOf(`${kind}\n${spaceId}\n${text}`);
    if (all('SELECT 1 FROM note_text_sources WHERE item_id = ? AND identity = ? LIMIT 1', itemId, identity).length) return { item_id: itemId, changed: false };
    const { tasks, tags } = parseNoteText(text);
    transaction(() => {
      drop(itemId);
      for (const task of tasks) sql.exec('INSERT INTO note_tasks (item_id, position, line, text, done, kind, space_id) VALUES (?, ?, ?, ?, ?, ?, ?)', itemId, task.position, task.line, task.text, task.done ? 1 : 0, kind, spaceId);
      for (const tag of tags) sql.exec('INSERT INTO note_tags (item_id, tag, display, explicit, kind, space_id) VALUES (?, ?, ?, ?, ?, ?)', itemId, tag.tag, tag.display, tag.explicit ? 1 : 0, kind, spaceId);
      sql.exec('INSERT INTO note_text_sources (item_id, identity) VALUES (?, ?)', itemId, identity);
    });
    return { item_id: itemId, changed: true, tasks: tasks.length, tags: tags.length };
  };
  const remove = itemId => { const had = all('SELECT 1 FROM note_text_sources WHERE item_id = ? LIMIT 1', itemId).length > 0; if (had) transaction(() => drop(itemId)); return { item_id: itemId, removed: had }; };

  const textOf = value => {
    if (typeof value === 'string') return value;
    for (const field of settings.result_text_fields) if (typeof value?.[field] === 'string') return value[field];
    return '';
  };
  const resultKinds = JSON.stringify(settings.result_kinds);
  /** Brings the index up to date with the notes kept as file results, one bounded page at a time: { indexed, removed, more }. */
  const syncResults = () => {
    if (!all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'namespace_results'").length) return { indexed: 0, removed: 0, more: false };
    const prefix = settings.result_item_prefix;
    const itemOf = "? || r.identity || '#' || r.kind";
    const stale = all(`SELECT r.identity, r.kind, r.value_identity FROM namespace_results r LEFT JOIN note_text_sources s ON s.item_id = ${itemOf} WHERE r.kind IN (SELECT value FROM json_each(?)) AND (s.item_id IS NULL OR s.identity <> r.value_identity) LIMIT ?`, prefix, resultKinds, settings.sync_batch + 1);
    let indexed = 0;
    for (const row of stale.slice(0, settings.sync_batch)) {
      const held = all('SELECT value FROM namespace_results WHERE identity = ? AND kind = ? LIMIT 1', row.identity, row.kind)[0];
      let value = null;
      try { value = held ? JSON.parse(held.value) : null; } catch { value = null; }
      const text = textOf(value).slice(0, settings.max_text_chars);
      index({ item_id: `${prefix}${row.identity}#${row.kind}`, text, kind: row.kind, space_id: '', source_identity: row.value_identity });
      indexed++;
    }
    const gone = all("SELECT s.item_id FROM note_text_sources s WHERE substr(s.item_id, 1, ?) = ? AND NOT EXISTS (SELECT 1 FROM namespace_results r WHERE ? || r.identity || '#' || r.kind = s.item_id) LIMIT ?", prefix.length, prefix, prefix, settings.sync_batch);
    for (const row of gone) remove(row.item_id);
    return { indexed, removed: gone.length, more: stale.length > settings.sync_batch || gone.length === settings.sync_batch };
  };

  const spaceFilter = spaceId => typeof spaceId === 'string' && spaceId ? [' AND space_id = ?', [spaceId]] : ['', []];
  return {
    index,
    remove,
    syncResults,
    /** Drops the derived rows and indexes `notes` again (an iterable of { item_id, text, kind?, space_id? }). */
    rebuild(notes) {
      transaction(() => { sql.exec('DELETE FROM note_tasks'); sql.exec('DELETE FROM note_tags'); sql.exec('DELETE FROM note_text_sources'); });
      let count = 0;
      for (const note of notes) { index(note); count++; }
      return { rebuilt: count };
    },
    /** Checkbox tasks, in note then written order: { done } keeps open (false) or done (true) ones; after is the last item_id of the page before. */
    tasks({ space_id: spaceId, done, kind, after, limit } = {}) {
      const [filter, args] = spaceFilter(spaceId);
      const rows = all(`SELECT item_id, position, text, done, kind, space_id FROM note_tasks WHERE 1 = 1${filter}${typeof done === 'boolean' ? ' AND done = ?' : ''}${typeof kind === 'string' && kind ? ' AND kind = ?' : ''}${typeof after === 'string' && after ? ' AND item_id > ?' : ''} ORDER BY item_id, position LIMIT ?`,
        ...args, ...(typeof done === 'boolean' ? [done ? 1 : 0] : []), ...(typeof kind === 'string' && kind ? [kind] : []), ...(typeof after === 'string' && after ? [after] : []), limited(limit));
      return { tasks: rows.map(row => ({ ...row, done: row.done === 1 })) };
    },
    /** Every tag with how many notes carry it (its children count toward it); display is the explicit spelling first written. */
    tags({ space_id: spaceId, after, limit } = {}) {
      const [filter, args] = spaceFilter(spaceId);
      const size = limited(limit);
      const rows = all(`SELECT tag, COALESCE(MAX(CASE WHEN explicit = 1 THEN display END), MIN(display)) AS display, COUNT(DISTINCT item_id) AS notes FROM note_tags WHERE 1 = 1${filter}${typeof after === 'string' && after ? ' AND tag > ?' : ''} GROUP BY tag ORDER BY tag LIMIT ?`,
        ...args, ...(typeof after === 'string' && after ? [after] : []), size + 1);
      const page = rows.slice(0, size).map(row => ({ ...row }));
      return { tags: page, ...(rows.length > size ? { next_after: page.at(-1).tag } : {}) };
    },
    /** The notes carrying a tag or any tag beneath it, case-insensitively, each with its id for navigation. */
    itemsForTag(tag, { space_id: spaceId, limit } = {}) {
      const key = lowered(String(tag ?? '').replace(/^#/, '').trim());
      if (!key) throw new Error('Name the tag to look for.');
      const [filter, args] = spaceFilter(spaceId);
      const like = `${key.replace(/[\\%_]/g, '\\$&')}${sep}%`;
      const rows = all(`SELECT item_id, kind, space_id, MIN(tag) AS tag FROM note_tags WHERE (tag = ? OR tag LIKE ? ESCAPE '\\')${filter} GROUP BY item_id, kind, space_id ORDER BY item_id LIMIT ?`, key, like, ...args, limited(limit));
      return { tag: key, items: rows.map(({ item_id, kind, space_id }) => ({ item_id, kind, space_id })) };
    },
  };
}

const MAX_SYNC_PAGES = 20;
const json = (value, status = 200) => Response.json(value, { status });
const fail = (status, error) => json({ error }, status);

/**
 * The person's note index: the index over their store, brought up to date with their notes (file results) before every
 * read, so a task or tag written a moment ago is found. `transaction` wraps the writes of one call.
 */
export function noteTextStore(sql, { transaction = work => work() } = {}) {
  const index = noteTextIndex(sql, { transaction });
  const fresh = () => { for (let page = 0; page < MAX_SYNC_PAGES && index.syncResults().more; page++); };
  return {
    index,
    tasks: query => { fresh(); return index.tasks(query ?? {}); },
    tags: query => { fresh(); return index.tags(query ?? {}); },
    itemsForTag: (tag, query) => { fresh(); return index.itemsForTag(tag, query ?? {}); },
  };
}

export const isNotesPath = path => path === '/namespace/notes' || path.startsWith('/namespace/notes/');

// Routes (under /mcp/api and /work/api, read-only):
//   GET /namespace/notes/tasks?done=&kind=&space_id=&after=&limit=   checkbox tasks with the id of the note they are in
//   GET /namespace/notes/tags?space_id=&after=&limit=                the tags with how many notes carry each, a page at a time (next_after continues)
//   GET /namespace/notes/tags/<tag>?space_id=&limit=                 the notes carrying a tag or any tag beneath it
// `person` answers namespaceNotes(verb, ...args) from its noteTextStore.
export async function handleNotesApi(request, person, path, url) {
  if (request.method !== 'GET') return fail(405, 'Read with GET.');
  const param = name => url.searchParams.get(name) || undefined;
  const limit = Number(param('limit')) || undefined;
  if (path === '/namespace/notes/tasks') {
    const done = param('done');
    if (done !== undefined && done !== 'true' && done !== 'false') return fail(400, 'done is true or false.');
    return json(await person.namespaceNotes('tasks', { space_id: param('space_id'), kind: param('kind'), after: param('after'), limit, ...(done === undefined ? {} : { done: done === 'true' }) }));
  }
  if (path === '/namespace/notes/tags') return json(await person.namespaceNotes('tags', { space_id: param('space_id'), after: param('after'), limit }));
  const named = /^\/namespace\/notes\/tags\/(.+)$/.exec(path);
  if (named) {
    let tag;
    try { tag = decodeURIComponent(named[1]); } catch { return fail(400, 'That tag is not valid.'); }
    return json(await person.namespaceNotes('itemsForTag', tag, { space_id: param('space_id'), limit }));
  }
  return fail(404, 'Not found');
}

/** Read actions for the person's own store: list-tasks, list-tags, items-for-tag. `run(verb, ...args)` calls the store. */
export const noteTextActions = run => ({
  'list-tasks': async ({ space_id, done, kind, after, limit } = {}) => run('tasks', { space_id, done, kind, after, limit }),
  'list-tags': async ({ space_id, after, limit } = {}) => run('tags', { space_id, after, limit }),
  'items-for-tag': async ({ tag, space_id, limit } = {}) => run('itemsForTag', tag, { space_id, limit }),
});
