// src/search-candidate-pages.mjs
//
// Durable per-candidate rows used by search's resumable vector walks. A scan page writes at most its configured number
// of candidates, and readers advance by the monotonically assigned row key instead of serializing an ever-growing hit
// list into one SQLite TEXT value.

// The per-session candidate transfer cursor, with the columns an older store lacks. Its one creator.
export function realizeSearchCandidateTransfers(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS search_candidate_transfers (
    session TEXT PRIMARY KEY, lane TEXT NOT NULL, kind TEXT NOT NULL, source_question TEXT NOT NULL,
    after_score REAL, after_seq INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    fusion_session TEXT, source_revision TEXT, cursor_json TEXT
  )`);
  const columns = new Set(sql.exec('PRAGMA table_info(search_candidate_transfers)').toArray().map(row => row.name));
  for (const column of ['fusion_session', 'source_revision', 'cursor_json']) if (!columns.has(column)) sql.exec(`ALTER TABLE search_candidate_transfers ADD COLUMN ${column} TEXT`);
}

export function searchCandidatePages(sql, { pageSize = 128, transaction = fn => fn() } = {}) {
  const page = Math.max(1, Math.trunc(pageSize) || 1);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_candidate_hits (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    lane TEXT NOT NULL,
    question TEXT NOT NULL,
    set_lane TEXT NOT NULL DEFAULT '',
    identity TEXT NOT NULL,
    n INTEGER NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    timed INTEGER NOT NULL,
    said TEXT,
    score REAL NOT NULL,
    UNIQUE (kind, lane, question, set_lane, identity, n)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS search_candidate_hits_page ON search_candidate_hits (kind, lane, question, seq)');
  sql.exec('CREATE INDEX IF NOT EXISTS search_candidate_hits_ranked ON search_candidate_hits (kind, lane, question, score DESC, seq ASC)');
  // An answered-empty model lane still participated. Keep those facts beside
  // the candidate walk and transfer them in bounded pages, independently of hits.
  sql.exec(`CREATE TABLE IF NOT EXISTS search_candidate_participation (
    kind TEXT NOT NULL, lane TEXT NOT NULL, question TEXT NOT NULL, actual_lane TEXT NOT NULL,
    PRIMARY KEY (kind, lane, question, actual_lane)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_candidate_revision (
    kind TEXT NOT NULL, lane TEXT NOT NULL, question TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, lane, question)
  )`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_candidate_revision_insert AFTER INSERT ON search_candidate_hits BEGIN
    INSERT INTO search_candidate_revision (kind, lane, question, revision) VALUES (NEW.kind, NEW.lane, NEW.question, 1)
    ON CONFLICT(kind, lane, question) DO UPDATE SET revision=revision+1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_candidate_revision_update AFTER UPDATE ON search_candidate_hits BEGIN
    INSERT INTO search_candidate_revision (kind, lane, question, revision) VALUES (NEW.kind, NEW.lane, NEW.question, 1)
    ON CONFLICT(kind, lane, question) DO UPDATE SET revision=revision+1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_candidate_revision_delete AFTER DELETE ON search_candidate_hits BEGIN
    INSERT INTO search_candidate_revision (kind, lane, question, revision) VALUES (OLD.kind, OLD.lane, OLD.question, 1)
    ON CONFLICT(kind, lane, question) DO UPDATE SET revision=revision+1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_candidate_participation_revision_insert AFTER INSERT ON search_candidate_participation BEGIN
    INSERT INTO search_candidate_revision (kind, lane, question, revision) VALUES (NEW.kind, NEW.lane, NEW.question, 1)
    ON CONFLICT(kind, lane, question) DO UPDATE SET revision=revision+1;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS search_candidate_participation_revision_delete AFTER DELETE ON search_candidate_participation BEGIN
    INSERT INTO search_candidate_revision (kind, lane, question, revision) VALUES (OLD.kind, OLD.lane, OLD.question, 1)
    ON CONFLICT(kind, lane, question) DO UPDATE SET revision=revision+1;
  END`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_candidates (
    session TEXT NOT NULL, lane TEXT NOT NULL, set_lane TEXT NOT NULL DEFAULT '', identity TEXT NOT NULL,
    n INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, timed INTEGER NOT NULL, said TEXT, score REAL NOT NULL, source_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, lane, set_lane, identity, n)
  )`);
  const fusionColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_candidates)').toArray().map(row => row.name));
  if (!fusionColumns.has('source_seq')) sql.exec('ALTER TABLE search_fusion_candidates ADD COLUMN source_seq INTEGER NOT NULL DEFAULT 0');
  sql.exec('CREATE INDEX IF NOT EXISTS search_fusion_candidates_lane ON search_fusion_candidates (session, lane, set_lane, score DESC, identity, n)');
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_candidate_details (
    session TEXT NOT NULL, lane TEXT NOT NULL, identity TEXT NOT NULL, n INTEGER NOT NULL,
    start REAL NOT NULL, end REAL NOT NULL, timed INTEGER NOT NULL, said TEXT, score REAL NOT NULL,
    source_seq INTEGER NOT NULL, priority REAL NOT NULL DEFAULT 0, lane_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, lane, identity, n, source_seq)
  )`);
  const detailColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_candidate_details)').toArray().map(row => row.name));
  if (!detailColumns.has('priority')) sql.exec('ALTER TABLE search_fusion_candidate_details ADD COLUMN priority REAL NOT NULL DEFAULT 0');
  if (!detailColumns.has('lane_order')) sql.exec('ALTER TABLE search_fusion_candidate_details ADD COLUMN lane_order INTEGER NOT NULL DEFAULT 0');
  sql.exec('CREATE INDEX IF NOT EXISTS search_fusion_candidate_details_identity_v2 ON search_fusion_candidate_details (session, identity, priority DESC, lane_order ASC, source_seq ASC, lane ASC, n ASC)');
  sql.exec('CREATE INDEX IF NOT EXISTS search_fusion_candidate_details_lane ON search_fusion_candidate_details (session, identity, lane, priority DESC, source_seq ASC, n ASC)');
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_targets (
    session TEXT NOT NULL, identity TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY (session, identity), UNIQUE (session, ordinal)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_progress (
    session TEXT NOT NULL, identity TEXT NOT NULL, after_priority REAL, after_lane_order INTEGER NOT NULL DEFAULT 0,
    after_seq INTEGER NOT NULL DEFAULT 0, after_lane TEXT NOT NULL DEFAULT '', after_n INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, identity)
  )`);
  const hydrationProgressColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_hydration_progress)').toArray().map(row => row.name));
  if (!hydrationProgressColumns.has('processed')) sql.exec('ALTER TABLE search_fusion_hydration_progress ADD COLUMN processed INTEGER NOT NULL DEFAULT 0');
  for (const [name, declaration] of Object.entries({
    projection_phase: "TEXT NOT NULL DEFAULT 'places'",
    projection_cursor: "TEXT NOT NULL DEFAULT ''",
    projection_page: 'INTEGER NOT NULL DEFAULT 0',
  })) if (!hydrationProgressColumns.has(name)) sql.exec(`ALTER TABLE search_fusion_hydration_progress ADD COLUMN ${name} ${declaration}`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_places (
    session TEXT NOT NULL, identity TEXT NOT NULL, lane TEXT NOT NULL, n INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
    timed INTEGER NOT NULL, said TEXT, score REAL NOT NULL, priority REAL NOT NULL, lane_order INTEGER NOT NULL,
    source_seq INTEGER NOT NULL, PRIMARY KEY (session, identity, lane)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_moments (
    session TEXT NOT NULL, identity TEXT NOT NULL, ordinal INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL,
    timed INTEGER NOT NULL, said TEXT, PRIMARY KEY (session, identity, ordinal)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_moment_places (
    session TEXT NOT NULL, identity TEXT NOT NULL, ordinal INTEGER NOT NULL, lane TEXT NOT NULL, event_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, identity, ordinal, lane)
  )`);
  const momentPlaceColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_hydration_moment_places)').toArray().map(row => row.name));
  if (!momentPlaceColumns.has('event_order')) sql.exec('ALTER TABLE search_fusion_hydration_moment_places ADD COLUMN event_order INTEGER NOT NULL DEFAULT 0');
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_projection (
    session TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{"places":[],"ranks":[],"moments":[]}',
    PRIMARY KEY (session, identity)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_projection_pages (
    session TEXT NOT NULL, identity TEXT NOT NULL, seq INTEGER NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (session, identity, seq)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_hydration_state (
    session TEXT PRIMARY KEY, target_key TEXT NOT NULL, cleanup_table INTEGER NOT NULL DEFAULT -1, cleanup_after TEXT NOT NULL DEFAULT ''
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_lanes (
    session TEXT NOT NULL, lane TEXT NOT NULL, base_rank REAL NOT NULL, weight REAL NOT NULL, next_rank INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, lane)
  )`);
  const fusionLaneColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_lanes)').toArray().map(row => row.name));
  if (!fusionLaneColumns.has('next_rank')) sql.exec('ALTER TABLE search_fusion_lanes ADD COLUMN next_rank INTEGER NOT NULL DEFAULT 0');
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_seen (
    session TEXT NOT NULL, lane TEXT NOT NULL, identity TEXT NOT NULL, rank INTEGER NOT NULL,
    PRIMARY KEY (session, lane, identity)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_totals (
    session TEXT NOT NULL, identity TEXT NOT NULL, score REAL NOT NULL,
    tie_score REAL NOT NULL DEFAULT 0, tie_lane INTEGER NOT NULL DEFAULT 0, tie_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, identity)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS search_fusion_totals_rank ON search_fusion_totals (session, score DESC, tie_score DESC, tie_lane ASC, tie_seq ASC, identity)');
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_session_state (
    session TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision TEXT NOT NULL DEFAULT '', complete INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_ordinary_progress (
    session TEXT NOT NULL, lane TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, detail_offset INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, lane)
  )`);
  const ordinaryColumns = new Set(sql.exec('PRAGMA table_info(search_fusion_ordinary_progress)').toArray().map(row => row.name));
  if (!ordinaryColumns.has('detail_offset')) sql.exec('ALTER TABLE search_fusion_ordinary_progress ADD COLUMN detail_offset INTEGER NOT NULL DEFAULT 0');
  realizeSearchCandidateTransfers(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_fusion_reset (
    session TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision TEXT NOT NULL, phase INTEGER NOT NULL DEFAULT 0, after_rowid INTEGER NOT NULL DEFAULT 0
  )`);

  const putPage = (kind, lane, question, hits, setLane = '') => {
    if (!Array.isArray(hits) || hits.length > page) throw new RangeError(`search candidate write page exceeds ${page}`);
    transaction(() => {
      for (const hit of hits) sql.exec(`INSERT INTO search_candidate_hits
        (kind, lane, question, set_lane, identity, n, start, end, timed, said, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, lane, question, set_lane, identity, n) DO UPDATE SET
          start=excluded.start, end=excluded.end, timed=excluded.timed, said=excluded.said, score=excluded.score`,
        kind, lane, question, setLane, hit.identity, hit.n ?? 0, hit.start ?? 0, hit.end ?? 0,
        Number(Boolean(hit.timed)), hit.said ?? null, hit.score);
    });
  };
  const readPage = (kind, lane, question, after = 0, limit = page) => {
    const size = Math.max(1, Math.min(page, Math.trunc(limit) || 1));
    const rows = sql.exec(`SELECT seq, set_lane, identity, n, start, end, timed, said, score FROM search_candidate_hits
      WHERE kind = ? AND lane = ? AND question = ? AND seq > ? ORDER BY seq LIMIT ?`,
    kind, lane, question, after, size).toArray();
    return { rows: rows.map(({ seq, set_lane, identity, n, start, end, timed, said, score }) => ({
      seq, set_lane, identity, n, start, end, timed: Boolean(timed), said, score,
    })), after: rows.at(-1)?.seq ?? after, more: rows.length === size };
  };
  // Score order is stable across repeated reads while a completed walk is immutable: ties follow insertion order.
  // The composite cursor avoids OFFSET, so sending a very deep exact candidate list has the same bounded page cost.
  // `relative` (a lane's `relative_floor`, DATA in src/search.json) keeps only candidates scoring at least that share of the
  // lane's best, so one strong hit does not drag marginal ones in behind it; the page that reaches the cut ends the list.
  const readRankedPage = (kind, lane, question, afterScore = null, afterSeq = 0, limit = page, relative = null) => {
    if (Number.isFinite(relative) && relative > 0) {
      const best = sql.exec('SELECT MAX(score) AS best FROM search_candidate_hits WHERE kind = ? AND lane = ? AND question = ? LIMIT 1', kind, lane, question).toArray()[0]?.best;
      const whole = readRankedPage(kind, lane, question, afterScore, afterSeq, limit);
      if (!Number.isFinite(best)) return whole;
      const rows = whole.rows.filter(row => row.score >= best * relative);
      return rows.length === whole.rows.length ? whole : { ...whole, rows, afterScore: rows.at(-1)?.score ?? whole.afterScore, afterSeq: rows.at(-1)?.seq ?? whole.afterSeq, more: false };
    }
    const size = Math.max(1, Math.min(page, Math.trunc(limit) || 1));
    const cursor = Number.isFinite(afterScore);
    let rows;
    let more = false;
    if (!cursor) {
      const fetched = sql.exec(`SELECT seq, set_lane, identity, n, start, end, timed, said, score FROM search_candidate_hits
        WHERE kind = ? AND lane = ? AND question = ? ORDER BY score DESC, seq ASC LIMIT ?`, kind, lane, question, size + 1).toArray();
      more = fetched.length > size;
      rows = fetched.slice(0, size);
    } else {
      // Keep equal-score ties on their own (score, seq) index range, then continue into lower scores. The two seeks
      // avoid an OR predicate that can turn a page-sized read into a broad scan or temporary sort.
      const same = sql.exec(`SELECT seq, set_lane, identity, n, start, end, timed, said, score FROM search_candidate_hits
        WHERE kind = ? AND lane = ? AND question = ? AND score = ? AND seq > ? ORDER BY score DESC, seq ASC LIMIT ?`,
      kind, lane, question, afterScore, afterSeq, size + 1).toArray();
      if (same.length > size) {
        rows = same.slice(0, size);
        more = true;
      } else {
        const lower = sql.exec(`SELECT seq, set_lane, identity, n, start, end, timed, said, score FROM search_candidate_hits
          WHERE kind = ? AND lane = ? AND question = ? AND score < ? ORDER BY score DESC, seq ASC LIMIT ?`,
        kind, lane, question, afterScore, size + 1 - same.length).toArray();
        const combined = [...same, ...lower];
        more = combined.length > size;
        rows = combined.slice(0, size);
      }
    }
    return { rows: rows.map(({ seq, set_lane, identity, n, start, end, timed, said, score }) => ({
      seq, set_lane, identity, n, start, end, timed: Boolean(timed), said, score,
    })), afterScore: rows.at(-1)?.score ?? afterScore, afterSeq: rows.at(-1)?.seq ?? afterSeq, more };
  };
  // Move one bounded source page to a second durable collection, optionally giving every row its sets lane.
  const copyPage = (sourceKind, sourceLane, sourceQuestion, after = 0, targetKind, targetLane, targetQuestion, setLane = '') => {
    const source = readPage(sourceKind, sourceLane, sourceQuestion, after);
    if (source.rows.length) putPage(targetKind, targetLane, targetQuestion, source.rows, setLane);
    return { copied: source.rows.length, after: source.after, more: source.more };
  };
  const candidatePage = (ref, cursor = {}) => {
    const limit = Number.isFinite(ref.max_hits) ? Math.max(0, ref.max_hits - (cursor.count ?? 0)) : page;
    const result = !limit || cursor.hits_done
      ? { rows: [], afterScore: cursor.score ?? null, afterSeq: cursor.seq ?? 0, more: false }
      : readRankedPage(ref.kind, ref.lane, ref.question, cursor.score ?? null, cursor.seq ?? 0, Math.min(page, limit), ref.relative_floor ?? null);
    const count = (cursor.count ?? 0) + result.rows.length;
    const capped = Number.isFinite(ref.max_hits) && count >= ref.max_hits;
    const participated = cursor.participation_done ? [] : sql.exec(`SELECT actual_lane FROM search_candidate_participation
      WHERE kind = ? AND lane = ? AND question = ? AND actual_lane > ? ORDER BY actual_lane LIMIT ?`,
    ref.kind, ref.lane, ref.question, cursor.participation_after ?? '', page + 1).toArray();
    const selected = participated.slice(0, page).map(row => row.actual_lane);
    const hitsDone = capped || !result.more;
    const participationDone = cursor.participation_done || participated.length <= page;
    const next = { score: result.afterScore, seq: result.afterSeq, count, hits_done: hitsDone,
      participation_after: selected.at(-1) ?? cursor.participation_after ?? '', participation_done: participationDone };
    const revision = sourceRevision(ref.kind, ref.lane, ref.question);
    return { ...result, count, revision, participated: selected, cursor: next, more: !hitsDone || !participationDone };
  };
  const sourceRevision = (kind, lane, question) => sql.exec('SELECT revision FROM search_candidate_revision WHERE kind = ? AND lane = ? AND question = ? LIMIT 1', kind, lane, question).toArray()[0]?.revision ?? 0;
  const acceptCandidatePage = (session, lane, rows) => {
    if (!Array.isArray(rows) || rows.length > page) throw new RangeError(`search candidate transfer exceeds ${page}`);
    transaction(() => {
      for (const hit of rows) sql.exec(`INSERT INTO search_fusion_candidates
        (session, lane, set_lane, identity, n, start, end, timed, said, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session, lane, set_lane, identity, n) DO UPDATE SET
          start=excluded.start, end=excluded.end, timed=excluded.timed, said=excluded.said, score=excluded.score`,
      session, lane, hit.set_lane ?? '', hit.identity, hit.n ?? 0, hit.start ?? 0, hit.end ?? 0,
      Number(Boolean(hit.timed)), hit.said ?? null, hit.score);
    });
  };
  // A page is already in stable descending score order. First-seen identities therefore have their exact lane rank.
  // The seen row, rank counter, detail row and reciprocal-rank total commit together; replaying a transfer page cannot
  // move a rank or credit a lane twice.
  const rankCandidatePage = (session, rows, lanes, { k = 60, transfer = null, details = true, detailRows = [], progress = null } = {}) => {
    if (!Array.isArray(rows) || rows.length > page || !Array.isArray(detailRows) || detailRows.length > page) throw new RangeError(`search candidate ranking exceeds ${page}`);
    const descriptors = lanes instanceof Map ? lanes : new Map(Object.entries(lanes ?? {}));
    transaction(() => {
      const writeDetail = hit => {
        const lane = hit.lane;
        const descriptor = descriptors.get(lane);
        if (!descriptor || !hit.identity) return;
        const identity = hit.identity;
        sql.exec(`INSERT OR REPLACE INTO search_fusion_candidate_details
          (session, lane, identity, n, start, end, timed, said, score, source_seq, priority, lane_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session, lane, identity, hit.n ?? 0, hit.start ?? 0, hit.end ?? 0, Number(Boolean(hit.timed)), hit.said ?? null,
        hit.score, hit.source_seq ?? hit.seq ?? 0, hit.score * descriptor.baseRank, descriptor.order ?? 0);
      };
      for (const hit of rows) {
        const lane = hit.lane;
        const descriptor = descriptors.get(lane);
        if (!descriptor || !hit.identity) continue;
        const identity = hit.identity;
        const found = sql.exec('SELECT rank FROM search_fusion_seen WHERE session = ? AND lane = ? AND identity = ? LIMIT 1', session, lane, identity).toArray()[0];
        if (details) writeDetail(hit);
        if (found) continue;
        const rank = sql.exec('UPDATE search_fusion_lanes SET next_rank = next_rank + 1 WHERE session = ? AND lane = ? RETURNING next_rank AS rank', session, lane).toArray()[0]?.rank;
        if (!rank) throw new Error(`search fusion lane ${lane} has no rank state`);
        const contribution = descriptor.baseRank * descriptor.weight / (k + rank);
        const tieScore = hit.score * descriptor.baseRank;
        const tieLane = descriptor.order ?? 0;
        const tieSeq = hit.source_seq ?? hit.seq ?? rank;
        sql.exec('INSERT INTO search_fusion_seen (session, lane, identity, rank) VALUES (?, ?, ?, ?)', session, lane, identity, rank);
        sql.exec(`INSERT INTO search_fusion_totals (session, identity, score, tie_score, tie_lane, tie_seq)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session, identity) DO UPDATE SET
            score=score + excluded.score,
            tie_score=MAX(tie_score, excluded.tie_score),
            tie_lane=CASE WHEN excluded.tie_score > tie_score OR (excluded.tie_score = tie_score AND excluded.tie_lane < tie_lane) THEN excluded.tie_lane ELSE tie_lane END,
            tie_seq=CASE WHEN excluded.tie_score > tie_score OR (excluded.tie_score = tie_score AND (excluded.tie_lane < tie_lane OR (excluded.tie_lane = tie_lane AND excluded.tie_seq < tie_seq))) THEN excluded.tie_seq ELSE tie_seq END`,
        session, identity, contribution, tieScore, tieLane, tieSeq);
      }
      for (const hit of detailRows) writeDetail(hit);
      if (transfer) sql.exec(`UPDATE search_candidate_transfers SET after_score = ?, after_seq = ?, count = ?, done = ?, fusion_session = ?, source_revision = ?, cursor_json = ? WHERE session = ?`,
        transfer.afterScore ?? null, transfer.afterSeq ?? 0, transfer.count ?? 0, Number(Boolean(transfer.done)), session, String(transfer.sourceRevision ?? 0),
        JSON.stringify(transfer.cursor ?? { score: transfer.afterScore, seq: transfer.afterSeq, count: transfer.count }), transfer.session);
      if (progress) sql.exec(`UPDATE search_fusion_ordinary_progress SET offset = ?, detail_offset = ?, done = ? WHERE session = ? AND lane = ?`,
        progress.offset, progress.detailOffset ?? 0, Number(Boolean(progress.done)), session, progress.lane);
    });
  };
  const topTotals = (session, after = null, limit = page) => {
    const size = Math.max(1, Math.trunc(limit) || 1);
    const rows = sql.exec(`SELECT identity, score, tie_score, tie_lane, tie_seq FROM search_fusion_totals
      WHERE session = ? ${after ? 'AND (score < ? OR (score = ? AND (tie_score < ? OR (tie_score = ? AND (tie_lane > ? OR (tie_lane = ? AND (tie_seq > ? OR (tie_seq = ? AND identity > ?)))))))' : ''}
      ORDER BY score DESC, tie_score DESC, tie_lane ASC, tie_seq ASC, identity ASC LIMIT ?`,
    ...(after ? [session, after.score, after.score, after.tie_score, after.tie_score, after.tie_lane, after.tie_lane, after.tie_seq, after.tie_seq, after.identity, size] : [session, size])).toArray();
    return { rows, after: rows.at(-1) ?? after, more: rows.length === size };
  };
  const hydrationPage = (session, identity, cursor = null, limit = page) => {
    const size = Math.max(1, Math.min(page, Math.trunc(limit) || 1));
    let rows;
    if (!cursor) {
      rows = sql.exec(`SELECT lane, n, start, end, timed, said, score, source_seq, priority, lane_order FROM search_fusion_candidate_details
        WHERE session = ? AND identity = ? ORDER BY priority DESC, lane_order ASC, source_seq ASC, lane ASC, n ASC LIMIT ?`,
      session, identity, size + 1).toArray();
    } else {
      const same = sql.exec(`SELECT lane, n, start, end, timed, said, score, source_seq, priority, lane_order FROM search_fusion_candidate_details
        WHERE session = ? AND identity = ? AND priority = ? AND (lane_order, source_seq, lane, n) > (?, ?, ?, ?)
        ORDER BY priority DESC, lane_order ASC, source_seq ASC, lane ASC, n ASC LIMIT ?`,
      session, identity, cursor.priority, cursor.lane_order, cursor.source_seq, cursor.lane, cursor.n, size + 1).toArray();
      if (same.length > size) rows = same;
      else {
        const lower = sql.exec(`SELECT lane, n, start, end, timed, said, score, source_seq, priority, lane_order FROM search_fusion_candidate_details
          WHERE session = ? AND identity = ? AND priority < ?
          ORDER BY priority DESC, lane_order ASC, source_seq ASC, lane ASC, n ASC LIMIT ?`,
        session, identity, cursor.priority, size + 1 - same.length).toArray();
        rows = [...same, ...lower];
      }
    }
    return { rows: rows.slice(0, size).map(row => ({ ...row, timed: Boolean(row.timed) })), more: rows.length > size };
  };
  const resetTables = [
    ['search_fusion_candidates', 'session'], ['search_fusion_candidate_details', 'session'],
    ['search_fusion_lanes', 'session'], ['search_fusion_seen', 'session'], ['search_fusion_totals', 'session'],
    ['search_fusion_ordinary_progress', 'session'], ['search_fusion_hydration_targets', 'session'],
    ['search_fusion_hydration_progress', 'session'], ['search_fusion_hydration_places', 'session'],
    ['search_fusion_hydration_moments', 'session'], ['search_fusion_hydration_moment_places', 'session'],
    ['search_fusion_hydration_projection', 'session'], ['search_fusion_projection_pages', 'session'], ['search_fusion_hydration_state', 'session'],
    ['search_candidate_transfers', 'fusion_session'],
  ];
  const resetPending = session => sql.exec('SELECT 1 FROM search_fusion_reset WHERE session = ? LIMIT 1', session).toArray().length > 0;
  const advanceFusionReset = session => {
    const reset = sql.exec('SELECT fingerprint, revision, phase, after_rowid FROM search_fusion_reset WHERE session = ? LIMIT 1', session).toArray()[0];
    if (!reset) return false;
    const [table, owner] = resetTables[reset.phase] ?? [];
    if (table) {
      const where = owner === 'session' ? 'session = ?' : 'fusion_session = ?';
      const rows = sql.exec(`SELECT rowid FROM ${table} WHERE ${where} AND rowid > ? ORDER BY rowid LIMIT ?`, session, reset.after_rowid, page).toArray();
      if (rows.length) transaction(() => sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map(row => row.rowid))));
      if (rows.length === page) sql.exec('UPDATE search_fusion_reset SET after_rowid = ? WHERE session = ?', rows.at(-1).rowid, session);
      else sql.exec('UPDATE search_fusion_reset SET phase = phase + 1, after_rowid = 0 WHERE session = ?', session);
      return true;
    }
    transaction(() => {
      sql.exec(`INSERT INTO search_fusion_session_state (session, fingerprint, revision, complete) VALUES (?, ?, ?, 0)
        ON CONFLICT(session) DO UPDATE SET fingerprint=excluded.fingerprint, revision=excluded.revision, complete=0`, session, reset.fingerprint, reset.revision);
      sql.exec('DELETE FROM search_fusion_reset WHERE session = ?', session);
    });
    return false;
  };
  const resetFusion = session => {
    const prior = sql.exec('SELECT fingerprint, revision FROM search_fusion_session_state WHERE session = ? LIMIT 1', session).toArray()[0] ?? { fingerprint: '', revision: '' };
    sql.exec(`INSERT INTO search_fusion_reset (session, fingerprint, revision, phase, after_rowid) VALUES (?, ?, ?, 0, 0)
      ON CONFLICT(session) DO NOTHING`, session, prior.fingerprint, prior.revision);
    advanceFusionReset(session);
    return resetPending(session);
  };
  const ensureFusionFingerprint = (session, fingerprint, revision = '') => {
    const prior = sql.exec('SELECT fingerprint, revision FROM search_fusion_session_state WHERE session = ? LIMIT 1', session).toArray()[0];
    if (resetPending(session) || prior && (prior.fingerprint !== fingerprint || prior.revision !== revision)) {
      sql.exec(`INSERT INTO search_fusion_reset (session, fingerprint, revision, phase, after_rowid) VALUES (?, ?, ?, 0, 0)
        ON CONFLICT(session) DO UPDATE SET fingerprint=excluded.fingerprint, revision=excluded.revision`, session, fingerprint, revision);
      advanceFusionReset(session);
      return true;
    }
    if (!prior) {
      sql.exec('INSERT INTO search_fusion_session_state (session, fingerprint, revision, complete) VALUES (?, ?, ?, 0)', session, fingerprint, revision);
      return true;
    }
    return false;
  };
  const fusionReady = (session, fingerprint = null, revision = null) => {
    if (resetPending(session)) return false;
    const state = sql.exec('SELECT fingerprint, revision FROM search_fusion_session_state WHERE session = ? LIMIT 1', session).toArray()[0];
    return Boolean(state && (fingerprint === null || state.fingerprint === fingerprint) && (revision === null || state.revision === revision));
  };
  const fusionState = session => sql.exec('SELECT fingerprint, revision, complete FROM search_fusion_session_state WHERE session = ? LIMIT 1', session).toArray()[0] ?? null;
  const fusionLanePage = (sessions, after = '', limit = page) => {
    const size = Math.max(1, Math.min(page, Math.trunc(limit) || 1));
    const rows = sql.exec(`SELECT DISTINCT lane FROM (
      SELECT CASE WHEN set_lane <> '' THEN set_lane ELSE lane END AS lane
      FROM search_fusion_candidates WHERE session IN (SELECT value FROM json_each(?))
    ) WHERE lane > ? ORDER BY lane LIMIT ?`,
    JSON.stringify(sessions), after, size).toArray();
    return { rows, after: rows.at(-1)?.lane ?? after, more: rows.length === size };
  };
  const setFusionLane = (session, lane, baseRank, weight) => sql.exec(`INSERT INTO search_fusion_lanes (session, lane, base_rank, weight)
    VALUES (?, ?, ?, ?) ON CONFLICT(session, lane) DO UPDATE SET base_rank=excluded.base_rank, weight=excluded.weight`, session, lane, baseRank, weight);
  const deletePage = (kind, lane, question, after = 0) => {
    const rows = sql.exec(`SELECT seq FROM search_candidate_hits
      WHERE kind = ? AND lane = ? AND question = ? AND seq > ? ORDER BY seq LIMIT ?`,
    kind, lane, question, after, page).toArray();
    if (rows.length) transaction(() => sql.exec(`DELETE FROM search_candidate_hits
      WHERE seq IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map(row => row.seq))));
    const participated = rows.length === page ? [] : sql.exec(`SELECT actual_lane FROM search_candidate_participation
      WHERE kind = ? AND lane = ? AND question = ? ORDER BY actual_lane LIMIT ?`, kind, lane, question, page).toArray();
    if (participated.length) transaction(() => {
      for (const row of participated) sql.exec('DELETE FROM search_candidate_participation WHERE kind = ? AND lane = ? AND question = ? AND actual_lane = ?', kind, lane, question, row.actual_lane);
    });
    return { deleted: rows.length, after: rows.at(-1)?.seq ?? after, more: rows.length === page || participated.length === page };
  };
  return { pageSize: page, putPage, readPage, readRankedPage, copyPage, candidatePage, sourceRevision, acceptCandidatePage, rankCandidatePage, topTotals, hydrationPage, resetFusion, ensureFusionFingerprint, fusionReady, fusionState, fusionLanePage, setFusionLane, deletePage, resetPending };
}
