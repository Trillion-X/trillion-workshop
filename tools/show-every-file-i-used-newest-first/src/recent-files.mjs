// src/recent-files.mjs
//
// PURPOSE
//   Every file the person used, and how, newest first: opened, watched (played for a few seconds), edited, published,
//   or any other word a screen or an AI reports. It backs the Recent screen (src/workspace/recent-screen.tsx), the
//   recent_files and record_file_use tools (src/file-tools.mjs) and the account tools of the same job
//   (records/workshop-account-tool-records.json). Ported from the Mac's activity-history.mjs.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A use is DATA: { file, kind }. `kind` is an open set of short words (recent-files.json kind_pattern); this file
//      never lists the kinds it accepts, and how each reads on screen is recent-files.json `words`.
//   2. The owner stamps the time with its own clock; a caller never supplies one, so no client can reorder the list.
//   3. A use names a file this person keeps: the caller's name or identity is resolved through `locate`, and the use is
//      kept under the file's own content identity, so a file used by two of its names is one row. A file that is not
//      theirs is refused in words.
//   4. One row per file and kind, holding its newest time, so a file watched a hundred times is one row per kind and
//      the table never grows with repeats; at most `keep` files are held, the one used longest ago leaving first.
//   5. What a row is called and its type are read from the files at read time (`locate`), so a renamed file reads by
//      its new name, and a file no longer kept drops out of the list.

import { afterTimeCursor, readTimeCursor, timeCursor } from '../../recently-deleted-and-storage/time-cursor.mjs';
import settings from './recent-files.json' with { type: 'json' };

/** How a kind of use reads on screen: its row in `words`, else the word itself, first letter raised, dashes as spaces. */
export function useWords(kind, config = settings) {
  if (typeof kind !== 'string' || !kind) return '';
  return config.words[kind] ?? kind[0].toUpperCase() + kind.slice(1).replace(/-/g, ' ');
}

const baseName = name => name.slice(name.lastIndexOf('/') + 1) || name;

/**
 * The person's recent files in their own SQLite. `locate(nameOrIdentity)` answers the file this person keeps under
 * that name or identity ({ identity, media_type, names }) or null.
 */
export function recentFilesStore(sql, { locate, now = () => new Date(), config = settings } = {}) {
  if (typeof locate !== 'function') throw new Error('Recent files need a way to find the person\'s files.');
  const kindPattern = new RegExp(config.kind_pattern);
  sql.exec('CREATE TABLE IF NOT EXISTS recent_file_uses (identity TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (identity, kind))');
  sql.exec('CREATE INDEX IF NOT EXISTS recent_file_uses_at ON recent_file_uses (at)');

  function trim() {
    const [{ files }] = sql.exec('SELECT COUNT(DISTINCT identity) AS files FROM recent_file_uses').toArray();
    if (files <= config.keep) return;
    sql.exec('DELETE FROM recent_file_uses WHERE identity IN (SELECT identity FROM recent_file_uses GROUP BY identity ORDER BY MAX(at) DESC LIMIT -1 OFFSET ?)', config.keep);
  }

  /** The row the list shows for one file, from its kept uses (newest kind and time, every kind's newest time). */
  function shaped({ identity, last_at, last_kind, kinds }) {
    const found = locate(identity);
    if (!found) return null;
    const name = found.names?.[0] ?? null;
    return {
      identity, name, title: name ? baseName(name) : identity, media_type: found.media_type ?? null,
      last_at, last_kind, last_words: useWords(last_kind, config), kinds: JSON.parse(kinds),
    };
  }

  const usesOf = identity => JSON.stringify(Object.fromEntries(sql.exec('SELECT kind, at FROM recent_file_uses WHERE identity = ?', identity).toArray().map(row => [row.kind, row.at])));

  /** Keeps that `file` (a name starting with / or a content identity) was used as `kind`, now. Answers its row. */
  function record(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Say which file this was and what happened.');
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    if (!file || file.length > 1000) throw new Error('Say which file this was, by its name or its identity.');
    const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
    if (!kindPattern.test(kind)) throw new Error('Say what happened in one short word, such as opened, watched or edited.');
    const found = locate(file);
    if (!found) throw new Error(`${file} is not in your files.`);
    const at = now().toISOString();
    sql.exec('INSERT INTO recent_file_uses (identity, kind, at) VALUES (?, ?, ?) ON CONFLICT(identity, kind) DO UPDATE SET at = excluded.at', found.identity, kind, at);
    trim();
    return { recorded: true, file: shaped({ identity: found.identity, last_at: at, last_kind: kind, kinds: usesOf(found.identity) }) };
  }

  /**
   * Newest first: { items, next_before, said }. Each item is one file: identity, name, title, media_type, last_at,
   * last_kind, last_words and kinds ({ kind: newest time }); `said` is the count in words. `before` (an earlier page's
   * next_before) reads older files.
   */
  function recent({ limit, before } = {}) {
    const asked = Number(limit);
    const size = Math.max(1, Math.min(config.list_max, Number.isSafeInteger(asked) && asked > 0 ? asked : config.list_default));
    const older = readTimeCursor(before);
    // Paged by the last file's time and identity, so files used in the same instant are never skipped (src/time-cursor.mjs).
    const after = afterTimeCursor(older, 'MAX(at)', 'identity');
    // SQLite answers the bare `kind` from the row holding MAX(at), so last_kind is the newest use's word.
    const rows = sql.exec(`SELECT identity, MAX(at) AS last_at, kind AS last_kind, json_group_object(kind, at) AS kinds FROM recent_file_uses
      GROUP BY identity HAVING ${after.sql} ORDER BY last_at DESC, identity DESC LIMIT ?`, ...after.args, size + 1).toArray();
    const page = rows.slice(0, size);
    const items = page.map(shaped).filter(Boolean);
    const said = items.length ? `${items.length} ${items.length === 1 ? 'file' : 'files'} used, newest first.` : older ? 'No older files used.' : 'No files used yet.';
    return { items, next_before: rows.length > size ? timeCursor(page.at(-1).last_at, page.at(-1).identity) : null, said };
  }

  return { record, recent };
}
