// A bounded, durable index from a listening turn's identity to its kept recording and timed segment.
// The source id is produced by computer/listen.mjs and retained on each segment in the transcript result.
const TABLE = 'transcript_source_segments';
const PAGE = 256;

function install(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    source_id TEXT NOT NULL, identity TEXT NOT NULL, value_identity TEXT NOT NULL,
    segment_index INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
    PRIMARY KEY (identity, segment_index))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS transcript_source_segments_lookup ON ${TABLE} (source_id, identity)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS transcript_source_index_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), after_identity TEXT NOT NULL,
    active_identity TEXT, active_value_identity TEXT, after_segment INTEGER NOT NULL,
    backfill_done INTEGER NOT NULL, next_lane TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS transcript_source_index_changes (
    identity TEXT PRIMARY KEY, after_segment INTEGER NOT NULL DEFAULT -1)`);
  sql.exec(`INSERT OR IGNORE INTO transcript_source_index_state
    (id, after_identity, active_identity, active_value_identity, after_segment, backfill_done, next_lane)
    VALUES (1, '', NULL, NULL, -1, 0, 'changes')`);
  const queueNew = `INSERT INTO transcript_source_index_changes (identity, after_segment) VALUES (NEW.identity, -1)
    ON CONFLICT(identity) DO UPDATE SET after_segment = -1;`;
  for (const [name, event, body] of [
    ['insert', 'AFTER INSERT ON namespace_results WHEN NEW.kind = \'transcript\'', queueNew],
    ['update', 'AFTER UPDATE OF identity, kind, value, value_identity ON namespace_results WHEN OLD.kind = \'transcript\' OR NEW.kind = \'transcript\'',
      `INSERT INTO transcript_source_index_changes (identity, after_segment) VALUES (OLD.identity, -1)
         ON CONFLICT(identity) DO UPDATE SET after_segment = -1;
       INSERT INTO transcript_source_index_changes (identity, after_segment) SELECT NEW.identity, -1 WHERE NEW.kind = 'transcript'
         ON CONFLICT(identity) DO UPDATE SET after_segment = -1;`],
    ['delete', 'AFTER DELETE ON namespace_results WHEN OLD.kind = \'transcript\'',
      `INSERT INTO transcript_source_index_changes (identity, after_segment) VALUES (OLD.identity, -1)
         ON CONFLICT(identity) DO UPDATE SET after_segment = -1;`],
  ]) sql.exec(`CREATE TRIGGER IF NOT EXISTS transcript_source_index_${name} ${event} BEGIN ${body} END`);
}

/** Create the index, answer exact source lookups, and advance one transcript segment page per scheduler turn. */
export function transcriptSourceIndex(sql, transaction = work => work()) {
  install(sql);
  // reads-ok: every query below names one row by key or carries its own LIMIT (at most PAGE segments).
  // reads-ok: every local caller limits output to 1, 2, or PAGE (256) rows; this bounds materialization, not JSON scan work.
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  const state = () => all(`SELECT after_identity, active_identity, active_value_identity, after_segment,
    backfill_done, next_lane FROM transcript_source_index_state WHERE id = 1 LIMIT 1`)[0];
  const pending = () => {
    const current = state();
    return current.backfill_done !== 1 || all('SELECT 1 FROM transcript_source_index_changes LIMIT 1').length > 0;
  };
  const resolve = sourceId => {
    if (typeof sourceId !== 'string' || !sourceId) return { ready: true, match: null };
    // A source id names one listened turn (moment.id#turn), so another transcript's queued work must not
    // hold this exact lookup behind whole-account backfill. value_identity rejects stale rows after edits.
    const rows = all(`SELECT s.identity, s.segment_index, s.start, s.end FROM ${TABLE} s
      JOIN namespace_results r ON r.identity = s.identity AND r.kind = 'transcript' AND r.value_identity = s.value_identity
      WHERE s.source_id = ? ORDER BY s.identity, s.segment_index LIMIT 2`, sourceId);
    const indexed = rows.length > 0;
    return { ready: indexed || !pending(), match: rows.length === 1 ? { identity: rows[0].identity, start: rows[0].start, end: rows[0].end } : null,
      ambiguous: rows.length > 1 };
  };
  // A bulk of arrivals (a carry or an import inserts a whole account's transcripts at once) queues every one of them as a
  // change, and the change lane would index each a turn before the backfill reaches it and indexes it again. When more
  // than a page of changes wait ahead of the backfill cursor, the backfill covers them: drop up to a page of them,
  // keeping the active transcript and any already indexed (an edit to those is real work). A change behind the cursor,
  // or fewer than a page ahead, stays queued and is processed one page per turn as before.
  const dropCoveredChanges = current => {
    if (current.backfill_done === 1) return;
    const ahead = all('SELECT identity FROM transcript_source_index_changes WHERE identity > ? ORDER BY identity LIMIT ?', current.after_identity, PAGE + 1);
    if (ahead.length <= PAGE) return;
    sql.exec(`DELETE FROM transcript_source_index_changes WHERE identity IN (
      SELECT c.identity FROM transcript_source_index_changes c WHERE c.identity > ? AND c.identity IS NOT ?
        AND NOT EXISTS (SELECT 1 FROM ${TABLE} s WHERE s.identity = c.identity) ORDER BY c.identity LIMIT ?)`,
    current.after_identity, current.active_identity, PAGE);
  };
  const advance = () => transaction(() => {
    let current = state();
    dropCoveredChanges(current);
    const changed = all('SELECT identity, after_segment FROM transcript_source_index_changes ORDER BY identity LIMIT 1')[0];
    let fromChange = false;
    let identity;
    let afterSegment;
    if (changed && (current.backfill_done === 1 && !current.active_identity || current.next_lane === 'changes')) {
      fromChange = true;
      identity = changed.identity;
      afterSegment = changed.after_segment;
    } else if (current.active_identity || current.backfill_done !== 1) {
      identity = current.active_identity ?? all(`SELECT identity FROM namespace_results
        WHERE kind = 'transcript' AND identity > ? ORDER BY identity LIMIT 1`, current.after_identity)[0]?.identity;
      afterSegment = current.active_identity ? current.after_segment : -1;
    } else if (changed) {
      fromChange = true;
      identity = changed.identity;
      afterSegment = changed.after_segment;
    }
    if (!identity) {
      if (current.backfill_done !== 1) sql.exec('UPDATE transcript_source_index_state SET backfill_done = 1 WHERE id = 1');
      return { done: !pending() };
    }

    const row = all(`SELECT value_identity FROM namespace_results WHERE identity = ? AND kind = 'transcript' LIMIT 1`, identity)[0];
    if (!row) {
      sql.exec(`DELETE FROM ${TABLE} WHERE identity = ?`, identity);
      if (fromChange) sql.exec('DELETE FROM transcript_source_index_changes WHERE identity = ?', identity);
      else sql.exec(`UPDATE transcript_source_index_state SET after_identity = ?, active_identity = NULL,
        active_value_identity = NULL, after_segment = -1, next_lane = 'changes' WHERE id = 1`, identity);
      return { done: !pending(), advanced: true };
    }

    if (!fromChange && (current.active_identity !== identity || current.active_value_identity !== row.value_identity)) {
      sql.exec(`UPDATE transcript_source_index_state SET active_identity = ?, active_value_identity = ?, after_segment = -1 WHERE id = 1`, identity, row.value_identity);
      afterSegment = -1;
      current = state();
    }
    const segments = all(`SELECT CAST(j.key AS INTEGER) AS segment_index,
        json_extract(j.value, '$.source_id') AS source_id,
        json_extract(j.value, '$.start') AS start, json_extract(j.value, '$.end') AS end
      FROM namespace_results r, json_each(r.value, '$.segments') j
      WHERE r.identity = ? AND r.kind = 'transcript' AND r.value_identity = ?
        AND CAST(j.key AS INTEGER) > ?
      ORDER BY CAST(j.key AS INTEGER) LIMIT ?`, identity, row.value_identity, afterSegment, PAGE);
    // Reconcile every visited slot, including malformed/missing source ids. Otherwise an older row at this
    // segment number can survive an edit and resolve falsely.
    if (segments.length) {
      sql.exec(`DELETE FROM ${TABLE} WHERE identity = ? AND segment_index BETWEEN ? AND ?`,
        identity, segments[0].segment_index, segments.at(-1).segment_index);
    }
    for (const segment of segments) {
      if (typeof segment.source_id !== 'string' || !segment.source_id || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
          || segment.start < 0 || segment.end <= segment.start) continue;
      sql.exec(`INSERT INTO ${TABLE} (source_id, identity, value_identity, segment_index, start, end)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(identity, segment_index) DO UPDATE SET
        source_id = excluded.source_id, value_identity = excluded.value_identity, start = excluded.start, end = excluded.end`,
      segment.source_id, identity, row.value_identity, segment.segment_index, segment.start, segment.end);
    }
    const lastSegment = segments.at(-1)?.segment_index ?? afterSegment;
    if (segments.length < PAGE) {
      sql.exec(`DELETE FROM ${TABLE} WHERE identity = ? AND (value_identity <> ? OR segment_index > ?)`,
        identity, row.value_identity, lastSegment);
      if (fromChange) {
        sql.exec('DELETE FROM transcript_source_index_changes WHERE identity = ?', identity);
        sql.exec(`UPDATE transcript_source_index_state SET next_lane = 'backfill' WHERE id = 1`);
      } else {
        sql.exec(`UPDATE transcript_source_index_state SET after_identity = ?, active_identity = NULL,
          active_value_identity = NULL, after_segment = -1, next_lane = 'changes',
          backfill_done = CASE WHEN NOT EXISTS (SELECT 1 FROM namespace_results WHERE kind = 'transcript' AND identity > ?)
            THEN 1 ELSE backfill_done END WHERE id = 1`, identity, identity);
      }
      return { done: !pending(), advanced: true };
    }
    if (fromChange) {
      sql.exec('UPDATE transcript_source_index_changes SET after_segment = ? WHERE identity = ?', lastSegment, identity);
      sql.exec(`UPDATE transcript_source_index_state SET next_lane = 'backfill' WHERE id = 1`);
    } else {
      sql.exec(`UPDATE transcript_source_index_state SET active_identity = ?, active_value_identity = ?, after_segment = ?, next_lane = 'changes' WHERE id = 1`,
        identity, row.value_identity, lastSegment);
    }
    return { done: false, advanced: true };
  });
  return { pending, resolve, advance };
}
