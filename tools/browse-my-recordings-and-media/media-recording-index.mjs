// A seekable, per-person order for the Media library's recording results. It stores no file bytes or joined facts.
const prepared = new WeakMap();
const MAX_BACKFILL_RESULTS = 10_000;
const RULE = 'first-lexical-name-modified-time';
const entryKind = '(SELECT kind FROM media_library_recording_entry_kind WHERE id = 1)';
const sortOf = identity => `COALESCE((SELECT n.modified_at_ms FROM namespace_names n
  WHERE n.identity IN (${identity}, (SELECT identity FROM namespace_aliases WHERE alias = ${identity}))
  ORDER BY n.name LIMIT 1), -1)`;
const insertResult = identity => `INSERT OR REPLACE INTO media_library_recording_candidates (identity, sort_ms)
  SELECT r.identity, ${sortOf('r.identity')} FROM namespace_results r
  WHERE r.identity = ${identity} AND r.kind = ${entryKind};`;
const refreshNamesOf = identity => `UPDATE media_library_recording_candidates
  SET sort_ms = ${sortOf('media_library_recording_candidates.identity')}
  WHERE identity = ${identity} OR identity IN (SELECT alias FROM namespace_aliases WHERE identity = ${identity});`;
const refreshAlias = alias => `UPDATE media_library_recording_candidates
  SET sort_ms = ${sortOf('media_library_recording_candidates.identity')} WHERE identity = ${alias};`;

function install(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_recording_candidates (
    identity TEXT PRIMARY KEY, sort_ms INTEGER NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS media_library_recording_candidates_recent
    ON media_library_recording_candidates (sort_ms DESC, identity DESC)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_recording_entry_kind (
    id INTEGER PRIMARY KEY CHECK (id = 1), kind TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS media_library_recording_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL, after_identity TEXT, ready INTEGER NOT NULL)`);
  const triggers = [
    ['result_insert', `AFTER INSERT ON namespace_results WHEN NEW.kind = ${entryKind}`, insertResult('NEW.identity')],
    ['result_update', `AFTER UPDATE OF identity, kind ON namespace_results
      WHEN OLD.kind = ${entryKind} OR NEW.kind = ${entryKind}`,
    `DELETE FROM media_library_recording_candidates WHERE identity = OLD.identity; ${insertResult('NEW.identity')}`],
    ['result_delete', `AFTER DELETE ON namespace_results WHEN OLD.kind = ${entryKind}`,
      'DELETE FROM media_library_recording_candidates WHERE identity = OLD.identity;'],
    ['name_insert', 'AFTER INSERT ON namespace_names', refreshNamesOf('NEW.identity')],
    ['name_update', 'AFTER UPDATE ON namespace_names', `${refreshNamesOf('OLD.identity')} ${refreshNamesOf('NEW.identity')}`],
    ['name_delete', 'AFTER DELETE ON namespace_names', refreshNamesOf('OLD.identity')],
    ['alias_insert', 'AFTER INSERT ON namespace_aliases', refreshAlias('NEW.alias')],
    ['alias_update', 'AFTER UPDATE OF alias, identity ON namespace_aliases',
      `${refreshAlias('OLD.alias')} ${refreshAlias('NEW.alias')}`],
    ['alias_delete', 'AFTER DELETE ON namespace_aliases', refreshAlias('OLD.alias')],
  ];
  for (const [name, event, body] of triggers) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS media_library_recording_${name} ${event} BEGIN ${body} END`);
  }
}

/** Whether an index already started by Media still has work for the account's one scheduler. */
export function mediaRecordingIndexPending(sql, config) {
  let state;
  try {
    state = sql.exec('SELECT choice, ready FROM media_library_recording_index_state WHERE id = 1').toArray()[0];
  } catch (error) {
    if (!/no such table: media_library_recording_index_state/.test(String(error))) throw error;
    return false;
  }
  if (!state) return false;
  return !state.ready || state.choice !== JSON.stringify([RULE, config.entry_kind]);
}

/** Install the direct-write index, then optionally advance one bounded legacy batch. */
export function ensureMediaRecordingIndex(sql, config, { advance = true } = {}) {
  const choice = JSON.stringify([RULE, config.entry_kind]);
  const cached = prepared.get(sql);
  if (cached?.choice !== choice) install(sql);
  let state;
  try {
    state = sql.exec('SELECT choice, after_identity, ready FROM media_library_recording_index_state WHERE id = 1').toArray()[0];
  } catch (error) {
    if (!/no such table: media_library_recording_index_state/.test(String(error))) throw error;
    // DDL inside a caller transaction may have rolled back after the in-memory cache was filled.
    install(sql);
  }
  // A DATA change may retire many old candidates. The page keeps using the legacy reader;
  // the account alarm performs that reset and its following backfill away from the request.
  if (state && state.choice !== choice && !advance) return false;
  if (!state || state.choice !== choice) {
    prepared.delete(sql);
    sql.exec('DELETE FROM media_library_recording_index_state');
    sql.exec('DELETE FROM media_library_recording_candidates');
    sql.exec('INSERT INTO media_library_recording_entry_kind (id, kind) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind', config.entry_kind);
    sql.exec('INSERT INTO media_library_recording_index_state (id, choice, after_identity, ready) VALUES (1, ?, NULL, 0)', choice);
    state = { choice, after_identity: null, ready: 0 };
  }
  if (state.ready) {
    prepared.set(sql, { choice, complete: true });
    return true;
  }
  if (!advance) {
    prepared.set(sql, { choice, complete: false });
    return false;
  }
  const count = Number(config.recording_index_backfill_per_wake ?? config.recording_index_backfill_per_read ?? MAX_BACKFILL_RESULTS);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BACKFILL_RESULTS) throw new Error('Media recording backfill size must be 1 to 10,000 results.');
  const results = sql.exec('SELECT identity FROM namespace_results WHERE kind = ? AND identity > ? ORDER BY identity LIMIT ?',
    config.entry_kind, state.after_identity ?? '', count + 1).toArray();
  const batch = results.slice(0, count);
  if (batch.length) {
    // Direct-write triggers may already have placed a newer value while this older slice was waiting.
    sql.exec(`INSERT OR IGNORE INTO media_library_recording_candidates (identity, sort_ms)
      SELECT r.identity, ${sortOf('r.identity')} FROM namespace_results r
      WHERE r.kind = ? AND r.identity > ? AND r.identity <= ?`,
    config.entry_kind, state.after_identity ?? '', batch.at(-1).identity);
    sql.exec('UPDATE media_library_recording_index_state SET after_identity = ? WHERE id = 1', batch.at(-1).identity);
  }
  if (results.length <= count) {
    sql.exec('UPDATE media_library_change SET changed = changed + 1 WHERE id = 1');
    sql.exec('UPDATE media_library_recording_index_state SET ready = 1 WHERE id = 1');
    prepared.set(sql, { choice, complete: true });
    return true;
  }
  prepared.set(sql, { choice, complete: false });
  return false;
}
