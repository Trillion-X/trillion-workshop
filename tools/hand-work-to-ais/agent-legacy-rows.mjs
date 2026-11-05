// Read an agent's older SQL rows while the record-log move is in progress.
// This opens no schema and builds no index. Every write goes to `current` (the record
// store), and a record ID always hides the corresponding older table row, even when
// the newer record no longer matches a list's filter. The reconciler's due work (dueReviews) is read from both sides,
// each side's dependencies resolved through this bridge; where its slice of open work ended is kept by `current`.
import { handoffProjection, projectHandoff, taskMapHandoff } from '../shared-code/src/handoff-projection.mjs';
import { MAX_PULLED, reviewOf } from '../shared-code/src/agents.mjs';
import { ownWorkFromTable, scheduledHandoffsPageFromTable } from './agent-schedule-rows.mjs';
import { AGENT_RECORD_TABLES, NotificationIndexBuilding } from './agent-records.mjs';

const TABLE = {
  card: ['agent_cards', 'agent_id', 'agent-card'],
  handoff: ['agent_handoffs', 'handoff_id', 'agent-handoff'],
  delivery: ['agent_deliveries', 'event_id', 'agent-delivery'],
  secret: ['agent_delivery_secrets', 'agent_id', 'agent-delivery-secret'],
};
// The tables whose first pass copies every row (src/agent-records.mjs AGENT_RECORD_TABLES `first` '1 = 1': cards and
// delivery secrets): every row through the pass's place is a record already, so only rows past it are read here.
const COPIED_WHOLE = new Set(AGENT_RECORD_TABLES.filter(owner => owner.first === '1 = 1').map(owner => owner.table));
const finiteLimit = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : Infinity;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const timeOrder = (a, b) => compareText(a.handed_at, b.handed_at) || compareText(a.handoff_id, b.handoff_id);
const newestOrder = (a, b) => -timeOrder(a, b);
const queueOrder = (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || timeOrder(a, b);
const deliveryOrder = (a, b) => compareText(a.next_at, b.next_at) || compareText(a.event_id, b.event_id);
const idOrder = (id) => (a, b) => compareText(a[id], b[id]);

/**
 * `current` is agentRecordStore({ records, transaction }). It remains the only
 * writer. `records.typeOf` distinguishes a missing record from an older table
 * value that a newer record superseded. The returned object has makeAgents'
 * complete store interface except savedInstructions/putSavedInstructions, which
 * PersonStore already adds beside either agent store.
 */
export function agentLegacyRows({ sql, records, current, placeOf = table => records.read(`table-move:${table}`) ?? {} }) {
  // Where each table's move has reached: the mover's own place (src/tables-into-records.mjs placeOf), which runs ahead
  // of its kept record until the next write-out. Read from the record instead, every read below re-walked old rows the
  // mover had already copied (Sam's events pull read 41,000 rows a call on 2026-10-06).
  // A table whose every row is already a record (`moved`, while it is let go a piece at a time) is not read: its
  // indexes go first, so a read of it would walk the whole table for rows the records already answer.
  // The mover marks a table moved before dropping it. Its place is live in memory, so
  // a table found once need not rescan sqlite_master on every legacy read.
  const present = new Map();
  const exists = kind => {
    const table = TABLE[kind][0];
    if (placeOf(table).moved === true) return false;
    if (!present.has(table)) present.set(table, sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0);
    return present.get(table);
  };
  const shadows = (kind, id) => records.hasState(`${TABLE[kind][2]}:${id}`);
  const older = (kind, id) => {
    if (shadows(kind, id) || !exists(kind)) return null;
    const [table, key] = TABLE[kind];
    const row = sql.exec(`SELECT * FROM ${table} WHERE ${key} = ?`, id).toArray()[0];
    return row ? kind === 'secret' ? { secret: row.secret } : JSON.parse(row.value) : null;
  };
  // Unmoved cards for many ids in one statement: a read per id cost one statement per receiver of a fan-out.
  const olderCards = ids => {
    const found = new Map();
    if (!ids.length || !exists('card')) return found;
    for (const row of sql.exec('SELECT agent_id, value FROM agent_cards WHERE agent_id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)).toArray()) found.set(row.agent_id, JSON.parse(row.value));
    return found;
  };
  const one = (kind, id, method) => {
    const latest = current[method](id);
    return latest !== null && latest !== undefined || shadows(kind, id) ? latest : older(kind, id);
  };
  // Each SQL statement returns at most one small page. This matters for hosts
  // that materialize a cursor before exposing it to the caller.
  function* pages(query, args = []) {
    for (let offset = 0; ;) {
      const page = sql.exec(`${query} LIMIT ? OFFSET ?`, ...args, 100, offset).toArray();
      yield* page;
      if (page.length < 100) return;
      offset += page.length;
    }
  }
  // Unordered reads continue from the last rowid they returned. An OFFSET page rereads every row before it, so the
  // last page of 5,283 legacy takers alone read 5,283 rows, and a whole scan cost the square of its length in pages.
  function* rowidPages(select, where, args = []) {
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const page = sql.exec(`${select} WHERE (${where}) AND rowid > ? ORDER BY rowid LIMIT ?`, ...args, after, 100).toArray();
      yield* page;
      if (page.length < 100) return;
      after = page.at(-1).seq;
    }
  }
  // Stop pulling SQLite rows once a caller's requested number of *visible* rows
  // is reached. A long prefix of superseded rows or an unindexed legacy filter
  // can still take proportional SQL work; no answer is silently underfilled.
  const rows = (kind, { where = '1 = 1', args = [], order = '', limit = Infinity, test = () => true, seekRowid = false, unmovedOpenOnly = false } = {}) => {
    if (!exists(kind) || finiteLimit(limit) === 0) return [];
    const [table, key] = TABLE[kind];
    const answer = [];
    // The historical move has already copied every handoff through `after`.
    // Excluding that prefix in SQL avoids paging through and checking each
    // shadowed job on every cold screen read while the old table drains.
    const place = kind === 'handoff' ? placeOf('agent_handoffs') : null;
    if (unmovedOpenOnly && place?.first_done) return [];
    // A table its first pass copies whole has nothing older to add through that pass's place: reading it again
    // walked all 716 of Sam's old cards, each checked against its record, on every open-work page.
    const movedThrough = kind === 'handoff' ? (unmovedOpenOnly ? place?.first_after ?? 0 : place?.after ?? 0)
      : COPIED_WHOLE.has(table) ? placeOf(table).first_after ?? 0 : null;
    const remaining = movedThrough === null ? where : `(${where}) AND rowid > ?`;
    const params = movedThrough === null ? args : [...args, movedThrough];
    const columns = `${key}, ${kind === 'secret' ? 'secret' : 'value'}`;
    const scan = order ? pages(`SELECT ${columns} FROM ${table}${seekRowid ? ' NOT INDEXED' : ''} WHERE ${remaining} ORDER BY ${order}`, params)
      : rowidPages(`SELECT rowid AS seq, ${columns} FROM ${table}${seekRowid ? ' NOT INDEXED' : ''}`, remaining, params);
    for (const row of scan) {
      if (shadows(kind, row[key])) continue;
      const value = kind === 'secret' ? { secret: row.secret } : JSON.parse(row.value);
      if (!test(value)) continue;
      answer.push(value);
      if (answer.length >= finiteLimit(limit)) break;
    }
    return answer;
  };
  const merged = (kind, methodRows, olderRows, key, order, limit = Infinity, test = () => true) => {
    const byId = new Map();
    for (const item of olderRows) byId.set(item[key], item);
    for (const item of methodRows) byId.set(item[key], item);
    return [...byId.values()].filter(test).sort(order).slice(0, finiteLimit(limit));
  };
  const cardRows = (where, args, test = () => true) => rows('card', { where, args, test });
  const handoffRows = (where, args, order, limit = Infinity, test = () => true, options = {}) => rows('handoff', { where, args, order, limit, test, ...options });
  const deliveryRows = (where, args, order, limit = Infinity, test = () => true, options = {}) => rows('delivery', { where, args, order, limit, test, ...options });
  // The first pass copies every waiting delivery through first_after into records.
  // Only the uninspected tail can still contribute a legacy waiting result.
  const waitingDeliveryRows = (where, args, order, limit = Infinity, test = () => true, { seekTail = false } = {}) => {
    const place = placeOf('agent_deliveries');
    if (place?.first_done) return [];
    // A due-time index does not seek on rowid across varying times: it rereads the copied prefix before applying
    // rowid > first_after. When a prefix was copied, start from the unmoved rowid tail for unaddressed due reads.
    const firstAfter = place?.first_after ?? 0;
    return deliveryRows(`(${where}) AND rowid > ?`, [...args, firstAfter], order, limit, test,
      { seekRowid: seekTail && firstAfter > 0 });
  };
  // The scheduler asks for this time several times while one PersonStore is open. The earliest
  // unmoved row remains the earliest as the mover advances until it crosses that row. Keep its
  // small SQL fields in memory, and discard it when a newer delivery write shadows the row.
  let legacyNextDue;
  const nextLegacyDelivery = () => {
    const place = placeOf('agent_deliveries');
    if (place?.first_done || !exists('delivery')) return null;
    const firstAfter = place?.first_after ?? 0;
    if (legacyNextDue === null) return null;
    if (legacyNextDue && legacyNextDue.rowid > firstAfter && !shadows('delivery', legacyNextDue.event_id)) return legacyNextDue;
    // Most historical deliveries are already sent. A short due-index probe often finds the
    // first unmoved waiting row without walking the much larger rowid tail. If its first page
    // consists only of copied or superseded rows, use the bounded rowid-tail path below.
    if (hasIndex('agent_deliveries_due')) {
      const indexed = sql.exec(`SELECT rowid, event_id, next_at FROM agent_deliveries INDEXED BY agent_deliveries_due
        WHERE state = 'waiting' AND next_at IS NOT NULL ORDER BY next_at LIMIT ?`, 32).toArray();
      const visible = indexed.find(row => row.rowid > firstAfter && !shadows('delivery', row.event_id));
      if (visible) return (legacyNextDue = visible);
      if (indexed.length < 32) return (legacyNextDue = null);
    }
    let mark = null;
    for (;;) {
      const after = mark ? ' AND (next_at, rowid) > (?, ?)' : '';
      const page = sql.exec(`SELECT rowid, event_id, next_at FROM agent_deliveries${firstAfter ? ' NOT INDEXED' : ''}
        WHERE state = 'waiting' AND next_at IS NOT NULL AND rowid > ?${after}
        ORDER BY next_at, rowid LIMIT ?`, firstAfter, ...(mark ? [mark.next_at, mark.rowid] : []), 32).toArray();
      const visible = page.find(row => !shadows('delivery', row.event_id));
      if (visible) return (legacyNextDue = visible);
      if (page.length < 32) return (legacyNextDue = null);
      mark = page.at(-1);
    }
  };
  const columns = kind => exists(kind) ? new Set(sql.exec(`PRAGMA table_info(${TABLE[kind][0]})`).toArray().map(row => row.name)) : new Set();
  const hasIndex = name => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?", name).toArray().length > 0;
  const cardColumns = columns('card');
  const cardPrepared = ['reader', 'takes_work', 'source_id', 'reaches'].every(name => cardColumns.has(name));
  const jobColumns = columns('handoff');
  // The old table writer created this partial index before filling state. It
  // makes the readiness check cheap even for a large handoff history.
  const jobPrepared = ['state', 'to_agent', 'taken_by', 'priority', 'source_id', 'depends_on', 'prefer_until'].every(name => jobColumns.has(name))
    && hasIndex('agent_handoffs_unfilled')
    && sql.exec('SELECT 1 FROM agent_handoffs WHERE open = 1 AND state IS NULL LIMIT 1').toArray().length === 0;
  const cardFact = path => cardPrepared ? ({ delivery: 'reaches' }[path] ?? path) : `json_extract(value, '$.${path}')`;
  const jobFact = path => {
    const named = { state: 'state', to_agent: 'to_agent', taken_by: 'taken_by', priority: 'priority',
      'input.arrived.source_id': 'source_id', depends_on: 'depends_on', prefer_until: 'prefer_until' }[path];
    if (jobPrepared && named) return named;
    if (path === 'prefer_until') return "CASE WHEN json_extract(value, '$.target.strict') = 0 THEN json_extract(value, '$.target.prefer_until') END";
    return `json_extract(value, '$.${path}')`;
  };
  const deliveryColumns = columns('delivery');
  const deliveryFact = path => path === 'event.subject_id' && deliveryColumns.has('subject_id') ? 'subject_id' : `json_extract(value, '$.${path}')`;
  const orderedJobs = 'handed_at, handoff_id';
  const newestJobs = 'handed_at DESC, handoff_id DESC';
  const priorityJobs = `${jobPrepared ? 'priority' : `COALESCE(${jobFact('priority')}, 0)`} DESC, handed_at, handoff_id`;
  // The first-row mover copies every open job up to first_after atomically with
  // its cursor. Those rows are already answered by the record index. Once its
  // first pass ends, no old open job needs to be read from this table at all.
  const unmovedOpenStart = () => {
    const place = placeOf('agent_handoffs');
    return place?.first_done ? null : Math.max(0, place?.first_after ?? 0);
  };
  const pendingFromOldTable = (ids, limit) => {
    const start = unmovedOpenStart();
    const wanted = finiteLimit(limit);
    if (start === null || wanted === 0 || !exists('handoff')) return [];
    const indexed = jobPrepared && hasIndex('agent_handoffs_pending');
    // Older prepared stores have a priority-ordered queue index but not the
    // newer per-recipient pending index. Walk that existing order once for all
    // recipients, instead of sorting each recipient's whole unmoved tail.
    const queueIndexed = jobPrepared && !indexed && hasIndex('agent_handoffs_queue');
    const priority = jobPrepared ? 'priority' : `COALESCE(${jobFact('priority')}, 0)`;
    const state = jobFact('state');
    const recipient = jobFact('to_agent');
    const uniqueIds = [...new Set(ids)];
    // A rare recipient can sit behind an arbitrarily long run of other agents'
    // higher-priority jobs in the queue index. The older addressed index can
    // prove that the complete recipient set is small without reading job bodies.
    // Keep a hard metadata budget; a dense set still uses the queue order.
    if (queueIndexed && hasIndex('agent_handoffs_addressed')) {
      const sparse = [];
      let remaining = 4_096;
      for (const id of uniqueIds) {
        const page = sql.exec(`SELECT handoff_id, handed_at, priority, to_agent FROM agent_handoffs INDEXED BY agent_handoffs_addressed
          WHERE open = 1 AND state = 'open' AND rowid > ? AND to_agent = ? LIMIT ?`, start, id, remaining + 1).toArray();
        if (page.length > remaining) { remaining = -1; break; }
        sparse.push(...page);
        remaining -= page.length;
      }
      if (remaining >= 0) {
        const visible = [];
        for (const row of sparse.sort(queueOrder)) {
          if (shadows('handoff', row.handoff_id)) continue;
          visible.push(row);
          if (visible.length >= wanted) break;
        }
        return visible;
      }
    }
    const table = `agent_handoffs${indexed ? ' INDEXED BY agent_handoffs_pending' : queueIndexed ? ' INDEXED BY agent_handoffs_queue' : ''}`;
    const fetch = (where, args) => (extra, cursor, count) => sql.exec(`SELECT handoff_id, handed_at, ${priority} AS priority, ${recipient} AS to_agent FROM ${table}
      WHERE open = 1 AND ${state} = 'open' AND rowid > ? AND ${where}${extra}
      ORDER BY ${priority} DESC, handed_at, handoff_id LIMIT ?`, start, ...args, ...cursor, count).toArray();
    const visible = select => {
      const answer = [];
      let mark = null;
      while (answer.length < wanted) {
        const count = Math.min(64, wanted === Infinity ? 64 : wanted - answer.length);
        let page;
        if (!mark) page = select('', [], count);
        else {
          const tied = select(` AND ${priority} = ? AND (handed_at, handoff_id) > (?, ?)`, [mark.priority, mark.handed_at, mark.handoff_id], count);
          const lower = tied.length < count ? select(` AND ${priority} < ?`, [mark.priority], count - tied.length) : [];
          page = [...tied, ...lower];
        }
        if (!page.length) break;
        for (const row of page) {
          mark = row;
          if (!shadows('handoff', row.handoff_id)) answer.push(row);
        }
        if (page.length < count) break;
      }
      return answer;
    };
    if (queueIndexed) return visible(fetch(`${recipient} IN (SELECT value FROM json_each(?))`, [JSON.stringify(uniqueIds)]));
    return uniqueIds.flatMap(id => visible(fetch(`${recipient} = ?`, [id])))
      .sort(queueOrder).slice(0, wanted);
  };
  // Jobs from the older table are kept whole; the task map is answered the same fields as the records answer it.
  const drawnIf = (taskMap, items) => taskMap ? items.map(taskMapHandoff) : items;
  const bothJobs = (method, where, args, order, limit = Infinity, test = () => true, options = {}) =>
    merged('handoff', method, handoffRows(where, args, order, limit, test, options), 'handoff_id', order === newestJobs ? newestOrder : order === priorityJobs ? queueOrder : timeOrder, limit, test);
  const bothDeliveries = (method, where, args, order, limit = Infinity, test = () => true) =>
    merged('delivery', method, deliveryRows(where, args, order, limit, test), 'event_id', order === 'next_at, event_id' ? deliveryOrder : idOrder('event_id'), limit, test);
  const bothWaitingDeliveries = (method, where, args, order, limit = Infinity, test = () => true, options = {}) => {
    // The record store already returns these in order after the waiting-delivery first pass is complete.
    if (placeOf('agent_deliveries')?.first_done) return method;
    return merged('delivery', method, waitingDeliveryRows(where, args, order, limit, test, options), 'event_id', order === 'next_at, event_id' ? deliveryOrder : idOrder('event_id'), limit, test);
  };
  const afterTime = (mark, newer = true) => mark ? { sql: `(handed_at, handoff_id) ${newer ? '>' : '<'} (?, ?)`, args: [mark.handed_at, mark.handoff_id] } : { sql: '1 = 1', args: [] };
  const withAfter = (where, after) => `(${where}) AND (${after.sql})`;
  const queueFits = (item, to_agent, nowIso) => to_agent
    ? item.to_agent === to_agent
    : !item.to_agent || item.target?.strict === false && item.target.prefer_until <= nowIso;
  // Whether a handoff is finished, on either side of the move: a dependency may be finished in the older table.
  const finished = id => api.handoff(id)?.state === 'finished';
  const ready = item => reviewOf(item).waits_on.every(finished);
  const recordJobsAfter = (mark, limit, projection = null) => {
    const n = finiteLimit(limit);
    const same = records.scan('agent-handoff', 'time', { equal: [1, mark.handed_at], idFrom: `agent-handoff:${mark.handoff_id}\0`, limit: n });
    const later = same.length < n ? records.scan('agent-handoff', 'time', { equal: [1], after: mark.handed_at, limit: n - same.length }) : [];
    return [...same, ...later].map(entry => current.handoff(entry.id.slice('agent-handoff:'.length), { projection })).filter(Boolean);
  };
  // A public open-work page asks for at most 51 jobs. Walk only the unmoved part of the old table and check record
  // shadows on small id/time rows before fetching any job value. Earlier first-pass rows already live in records;
  // reading their large old values just to discard them exhausted the busy person's store.
  const oldOpenPage = (mark, limit) => {
    const start = unmovedOpenStart();
    const wanted = finiteLimit(limit);
    if (start === null || wanted === 0 || !exists('handoff')) return [];
    const chosen = [];
    let cursor = mark;
    while (chosen.length < wanted) {
      // A small requested result may sit behind many shadows. Keep the metadata walk at a fixed page size so a
      // one-job request does not issue one SQL statement for each shadowed row.
      const size = 64;
      const page = sql.exec(`SELECT handoff_id, handed_at FROM agent_handoffs
        WHERE open = 1 AND rowid > ?${cursor ? ' AND (handed_at, handoff_id) > (?, ?)' : ''}
        ORDER BY handed_at, handoff_id LIMIT ?`, start,
      ...(cursor ? [cursor.handed_at, cursor.handoff_id] : []), size).toArray();
      for (const row of page) if (!shadows('handoff', row.handoff_id)) {
        chosen.push(row);
        if (chosen.length === wanted) break;
      }
      if (page.length < size) break;
      cursor = page.at(-1);
    }
    if (!chosen.length) return [];
    const values = new Map();
    for (let offset = 0; offset < chosen.length; offset += 64) {
      const ids = chosen.slice(offset, offset + 64).map(row => row.handoff_id);
      for (const row of sql.exec('SELECT handoff_id, value FROM agent_handoffs WHERE handoff_id IN (SELECT value FROM json_each(?))',
        JSON.stringify(ids))) values.set(row.handoff_id, JSON.parse(row.value));
    }
    return chosen.flatMap(row => values.has(row.handoff_id) ? [values.get(row.handoff_id)] : []);
  };
  const recordFinishedBefore = (mark, limit) => {
    const n = finiteLimit(limit);
    const same = records.scan('agent-handoff', 'time', { equal: [0, mark.handed_at], idTo: `agent-handoff:${mark.handoff_id}`, reverse: true, limit: n });
    const earlier = same.length < n ? records.scan('agent-handoff', 'time', { equal: [0], before: mark.handed_at, reverse: true, limit: n - same.length }) : [];
    return [...same, ...earlier].map(entry => current.handoff(entry.id.slice('agent-handoff:'.length))).filter(Boolean);
  };
  const LEGACY_REVIEW_PAGE = 32;
  const LEGACY_NEXT_REVIEW = 'legacy-next-review-search';
  const LEGACY_DUE_REVIEW = 'legacy-due-review-search';
  const reviewMark = name => current.reviewSearchMark(name);
  const putReviewMark = (name, mark) => current.putReviewSearchMark(name, mark);
  const reviewRevision = () => current.scheduleRevision();
  const orderedLegacyReviews = () => ['review_at', 'waits_on'].every(name => jobColumns.has(name)) && hasIndex('agent_handoffs_review');
  // One bounded SQL page in review order when the old table has its review index, otherwise rowid order. A cursor is
  // the review/rowid tuple (the table's implicit tie-breaker in the review index) or rowid, so a blocked prefix never
  // makes the next scheduler arm start from the beginning or forces an unbounded tie sort.
  const legacyReviewPage = (start, cursor, through, limit) => {
    const ordered = orderedLegacyReviews();
    let rows;
    if (ordered) {
      const later = (after, count) => {
        const args = [];
        // The review index orders physical pages. Do not combine it with the migration rowid watermark: a moved
        // prefix is shadowed below, and filtering that independent key here makes SQLite walk the whole prefix.
        let where = 'open = 1 AND review_at IS NOT NULL';
        if (through !== null) { where += ' AND review_at <= ?'; args.push(through); }
        if (after !== null) { where += ' AND review_at > ?'; args.push(after); }
        return sql.exec(`SELECT handoff_id, review_at, waits_on, rowid FROM agent_handoffs WHERE ${where} ORDER BY review_at, rowid LIMIT ?`, ...args, count).toArray();
      }
      if (cursor?.review_at === undefined) rows = later(null, limit);
      else {
        // The implicit rowid tie-breaker is part of the review index, but SQLite's OR form for a composite cursor
        // scans the whole equal-time prefix. Seek that timestamp's rowid tail separately, then advance to later times.
        // The cursor is always beyond this scan's initial rowid bound, so omit that redundant predicate here; keeping
        // both rowid bounds makes SQLite choose the older bound and walk the intervening equal-time entries again.
        const equalArgs = [cursor.review_at, cursor.rowid];
        let equalWhere = 'open = 1 AND review_at = ? AND rowid > ?';
        if (through !== null) { equalWhere += ' AND review_at <= ?'; equalArgs.push(through); }
        const equal = sql.exec(`SELECT handoff_id, review_at, waits_on, rowid FROM agent_handoffs WHERE ${equalWhere} ORDER BY rowid LIMIT ?`, ...equalArgs, limit).toArray();
        rows = equal.length === limit ? equal : [...equal, ...later(cursor.review_at, limit - equal.length)];
      }
    } else {
      const args = [start];
      let where = 'open = 1 AND rowid > ?';
      if (cursor?.rowid !== undefined) { where += ' AND rowid > ?'; args.push(cursor.rowid); }
      rows = sql.exec(`SELECT handoff_id, rowid, json_extract(value, '$.state') AS state,
        json_extract(value, '$.in_the_way') AS in_the_way,
        json_extract(value, '$.in_the_way_by') AS in_the_way_by,
        json_extract(value, '$.hold_until') AS hold_until,
        json_extract(value, '$.taken_at') AS taken_at,
        json_extract(value, '$.hold_minutes') AS hold_minutes,
        json_extract(value, '$.review_at') AS review_at,
        json_extract(value, '$.depends_on') AS depends_on
        FROM agent_handoffs WHERE ${where} ORDER BY rowid LIMIT ?`, ...args, limit).toArray();
    }
    const entries = rows.flatMap(row => {
      if (shadows('handoff', row.handoff_id)) return [];
      const facts = ordered ? { review_at: row.review_at, waits_on: JSON.parse(row.waits_on ?? '[]') }
        : reviewOf({ ...row, depends_on: JSON.parse(row.depends_on ?? '[]') });
      if (facts.review_at === null || through !== null && facts.review_at > through) return [];
      return [{ handoff_id: row.handoff_id, ...facts, ordered, cursor: ordered
        ? { review_at: row.review_at, rowid: row.rowid } : { rowid: row.rowid } }];
    });
    const last = rows.at(-1);
    return { entries, full: rows.length === limit, cursor: last ? ordered
      ? { review_at: last.review_at, rowid: last.rowid } : { rowid: last.rowid } : cursor };
  };
  const earlierReview = (a, b) => a === null ? b : b === null ? a : a < b ? a : b;
  const earliestLegacyReview = nowIso => {
    const start = unmovedOpenStart();
    if (start === null || !exists('handoff')) return null;
    const revision = reviewRevision();
    const saved = reviewMark(LEGACY_NEXT_REVIEW);
    if (saved?.done && saved.revision === revision) return saved.bestAt === '' ? nowIso : saved.bestAt;
    const dirty = Boolean(saved?.dirty || saved && saved.revision !== revision);
    // A handoff write can invalidate the cached best candidate or introduce an earlier review behind the old cursor.
    // Start a fresh pass and forget the prior minimum as soon as the durable schedule revision changes.
    const page = legacyReviewPage(start, dirty ? null : saved?.cursor ?? null, null, LEGACY_REVIEW_PAGE);
    let bestAt = dirty ? null : saved?.bestAt ?? null;
    let bestId = dirty ? null : saved?.bestId ?? null;
    for (const row of page.entries) if (ready(api.handoff(row.handoff_id))) {
      const at = row.review_at === '' ? nowIso : row.review_at;
      const bestTime = bestAt === '' ? nowIso : bestAt;
      if (bestAt === null || at < bestTime) { bestAt = row.review_at; bestId = row.handoff_id; }
    }
    const cursor = page.cursor;
    if (page.full) {
      putReviewMark(LEGACY_NEXT_REVIEW, { revision, cursor, bestAt, bestId, done: false, dirty: false });
      return earlierReview(bestAt === '' ? nowIso : bestAt, new Date(Date.parse(nowIso) + 1000).toISOString());
    }
    putReviewMark(LEGACY_NEXT_REVIEW, { revision, cursor: null, bestAt, bestId, done: true, dirty: false });
    return bestAt === '' ? nowIso : bestAt;
  };
  // Each legacy call inspects one SQL page. `through` only moves forward, and a pass whose dependency facts changed is
  // repeated once after reaching its end so a newly finished prerequisite cannot remain behind an old cursor.
  const dueLegacyReviews = (nowIso, limit) => {
    const start = unmovedOpenStart();
    const size = Math.min(finiteLimit(limit), LEGACY_REVIEW_PAGE);
    if (start === null || size === 0 || !exists('handoff')) return [];
    const revision = reviewRevision();
    const saved = reviewMark(LEGACY_DUE_REVIEW);
    const through = saved?.through && saved.through > nowIso ? saved.through : nowIso;
    const dirty = Boolean(saved?.dirty || saved && saved.revision !== revision);
    const page = legacyReviewPage(start, saved?.cursor ?? null, through, LEGACY_REVIEW_PAGE);
    const due = [];
    let last = null;
    for (const row of page.entries) {
      last = row;
      const item = api.handoff(row.handoff_id);
      if (item && ready(item)) due.push(item);
      if (due.length >= size) break;
    }
    const consumedAll = last === page.entries.at(-1);
    const more = Boolean(page.full || due.length >= size && !consumedAll);
    const cursor = more ? (consumedAll ? page.cursor : last?.cursor ?? saved?.cursor ?? null) : null;
    const next = { revision, through, cursor: dirty && !more ? null : cursor, dirty: dirty && more };
    if (JSON.stringify(saved ?? null) !== JSON.stringify(next)) putReviewMark(LEGACY_DUE_REVIEW, next);
    return due;
  };

  // Merge only the parent index facts. A newer record, including a removal, shadows an old table row even if it
  // belongs to another parent now. Each group stays in handed-time/identity order without reading child JSON.
  const handedOnMetadataFromMany = ids => {
    const groups = current.handedOnMetadataFromMany([...new Set(ids)]);
    if (!groups.size || !exists('handoff')) return groups;
    const after = placeOf('agent_handoffs').after ?? 0;
    for (const row of pages(`SELECT handoff_id, parent, handed_at FROM agent_handoffs
      WHERE parent IN (SELECT value FROM json_each(?)) AND rowid > ? ORDER BY handed_at, handoff_id`,
      [JSON.stringify([...groups.keys()]), after])) {
      if (!shadows('handoff', row.handoff_id)) groups.get(row.parent)?.push({ handoff_id: row.handoff_id, handed_at: row.handed_at });
    }
    for (const children of groups.values()) children.sort(timeOrder);
    return groups;
  };
  const api = {
    // Until every historical handoff has moved, even a ready record index is only part of this account's work.
    // Refuse that incomplete projection without sorting legacy JSON or hydrating the remaining SQL history.
    notificationWork: options => {
      if (exists('handoff')) throw new NotificationIndexBuilding();
      return current.notificationWork(options);
    },
    card: id => one('card', id, 'card'),
    cardsById: ids => {
      const latest = new Map(current.cardsById(ids).map(card => [card.agent_id, card]));
      const unmoved = [...new Set(ids)].filter(id => !latest.has(id) && !shadows('card', id));
      const olderById = olderCards(unmoved);
      return ids.map(id => latest.get(id) ?? olderById.get(id) ?? null).filter(Boolean);
    },
    putCard: card => current.putCard(card),
    cards: () => merged('card', current.cards(), cardRows('1 = 1', []), 'agent_id', idOrder('agent_id')),
    cardIdsOf: ({ reader, takes_work = false }) => {
      const ids = new Set(current.cardIdsOf({ reader, takes_work }));
      if (!exists('card')) return [...ids];
      const after = placeOf('agent_cards')?.first_after ?? 0;
      // A greeting needs card IDs, not their potentially large bodies. Newer records still shadow old rows even when
      // a card changed reader or stopped taking work; the table mover has already copied rows through `after`.
      const where = `${cardFact('reader')} = ?${takes_work ? ` AND ${cardFact('takes_work')} = 1` : ''}`;
      for (const row of pages(`SELECT agent_id FROM agent_cards WHERE (${where}) AND rowid > ?`, [reader, after])) {
        if (!shadows('card', row.agent_id)) ids.add(row.agent_id);
      }
      return [...ids];
    },
    takerIds: () => [...new Set([...current.takerIds(), ...cardRows(`${cardFact('takes_work')} = 1 AND ${cardFact('source_id')} IS NULL`, [], card => card.takes_work && !card.source_id).map(card => card.agent_id)])],
    cardsForSource: source => merged('card', current.cardsForSource(source), cardRows(`${cardFact('takes_work')} = 1 AND ${cardFact('source_id')} = ?`, [source]), 'agent_id', idOrder('agent_id')),
    reachableCards: () => merged('card', current.reachableCards(), cardRows(cardPrepared ? 'reaches = 1' : `${cardFact('delivery')} IS NOT NULL`, []), 'agent_id', idOrder('agent_id')),
    anyTaker: () => current.anyTaker() || rows('card', { where: `${cardFact('takes_work')} = 1`, limit: 1, test: card => card.takes_work }).length > 0,

    handoff: (id, { projection = null } = {}) => {
      const selected = handoffProjection(projection);
      const latest = current.handoff(id, { projection: selected });
      return latest !== null && latest !== undefined || shadows('handoff', id) ? latest : projectHandoff(older('handoff', id), selected);
    },
    putHandoff: item => current.putHandoff(item),
    openHandoffs: ({ after = null, limit = Infinity, projection = null } = {}) => {
      const selected = handoffProjection(projection);
      const mark = after ? api.handoff(after, { projection: { fields: ['handed_at'] } }) : null;
      if (after && !mark) return [];
      const currentRows = after && !shadows('handoff', after) ? recordJobsAfter(mark, limit, selected) : current.openHandoffs({ after, limit, projection: selected });
      return merged('handoff', currentRows, oldOpenPage(mark, limit), 'handoff_id', timeOrder, limit,
        item => item.state !== 'finished' && (!mark || timeOrder(item, mark) > 0)).map(item => projectHandoff(item, selected));
    },
    openScheduledHandoffsPage: ({ after = null, limit = 100 } = {}) => {
      limit = Math.min(100, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 100);
      const currentRows = current.openScheduledHandoffsPage({ after, limit });
      const start = unmovedOpenStart();
      const mark = after ? (typeof after === 'string' ? api.handoff(after) : after) : null;
      const olderRows = start === null ? [] : scheduledHandoffsPageFromTable(sql, {
        after: mark, afterRowid: start, limit, shadows: id => shadows('handoff', id),
      });
      return merged('handoff', currentRows, olderRows, 'handoff_id', timeOrder, limit,
        item => item.state !== 'finished' && (!mark || timeOrder(item, mark) > 0));
    },
    // The wake index holds only the records: while any open job still waits in the old table it cannot say it holds them all,
    // so the clock reads open work (openScheduledHandoffs above, which adds those rows).
    scheduledWake: { ...current.scheduledWake, ready: () => unmovedOpenStart() === null && current.scheduledWake.ready() },
    openScheduledHandoffs: () => {
      const all = [];
      for (let after = null;;) {
        const page = api.openScheduledHandoffsPage({ after, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
        after = page.at(-1);
      }
    },
    scheduleRevision: () => current.scheduleRevision?.() ?? 0,
    ownWorkWaiting: options => {
      const currentRows = current.ownWorkWaiting(options);
      const start = unmovedOpenStart();
      if (start === null) return currentRows;
      const olderRows = ownWorkFromTable(sql, { ...options, afterRowid: start,
        shadows: id => shadows('handoff', id) });
      return [...currentRows, ...olderRows].sort(timeOrder).slice(0, options.limit ?? 1);
    },
    newestOpen: (limit, { before = null } = {}) => {
      const mark = before ? api.handoff(before) : null;
      if (before && !mark) return [];
      const latest = current.newestOpen(limit, { before });
      const start = unmovedOpenStart();
      // Once the first pass copied every open job, the old table has no open
      // result left to contribute. Before then, its cursor excludes the copy.
      return start === null ? latest : bothJobs(latest, `open = 1 AND rowid > ?${mark ? ' AND (handed_at, handoff_id) < (?, ?)' : ''}`, mark ? [start, mark.handed_at, before] : [start], newestJobs, limit, item => item.state !== 'finished');
    },
    heldBy: id => bothJobs(current.heldBy(id), `open = 1 AND ${jobFact('taken_by')} = ?`, [id], orderedJobs, Infinity, item => item.state !== 'finished' && item.taken_by === id, { unmovedOpenOnly: true }),
    heldLoad: id => (unmovedOpenStart() === null ? current.heldLoad(id) : null),
    heldByMany: ids => {
      if (unmovedOpenStart() === null) return current.heldByMany(ids);
      const held = api.boardAgentLoads(ids, { includeWaiting: false }).held;
      return ids.flatMap(id => [...(held.get(id) ?? [])].sort(timeOrder));
    },
    boardAgentLoads: (ids, { includeWaiting = true } = {}) => {
      const loads = current.boardAgentLoads(ids, { includeWaiting });
      const start = unmovedOpenStart();
      if (start === null || !ids.length || !exists('handoff')) return loads;
      const wanted = new Set(ids);
      // The first-pass cursor excludes copied old rows. Resolve shadows before
      // counting: a newer finished record must hide an older open table row.
      if (jobPrepared && hasIndex('agent_handoffs_held') && (!includeWaiting || hasIndex('agent_handoffs_pending'))) {
        const names = JSON.stringify([...wanted]);
        for (const row of sql.exec(`SELECT handoff_id, value FROM agent_handoffs INDEXED BY agent_handoffs_held
          WHERE open = 1 AND taken_by IN (SELECT value FROM json_each(?)) AND rowid > ?`, names, start)) {
          if (shadows('handoff', row.handoff_id)) continue;
          const item = JSON.parse(row.value);
          if (wanted.has(item.taken_by) && item.state !== 'finished') loads.held.get(item.taken_by).push(item);
        }
        if (includeWaiting) for (const row of sql.exec(`SELECT handoff_id, to_agent FROM agent_handoffs INDEXED BY agent_handoffs_pending
          WHERE open = 1 AND state = 'open' AND to_agent IN (SELECT value FROM json_each(?)) AND rowid > ?`, names, start)) {
          if (!shadows('handoff', row.handoff_id) && wanted.has(row.to_agent)) loads.waiting.set(row.to_agent, loads.waiting.get(row.to_agent) + 1);
        }
      } else {
        let after = start;
        for (;;) {
          const page = sql.exec('SELECT rowid, handoff_id, value FROM agent_handoffs WHERE open = 1 AND rowid > ? ORDER BY rowid LIMIT 100', after).toArray();
          for (const row of page) {
            if (shadows('handoff', row.handoff_id)) continue;
            const item = JSON.parse(row.value);
            if (wanted.has(item.taken_by) && item.state !== 'finished') loads.held.get(item.taken_by).push(item);
            if (includeWaiting && wanted.has(item.to_agent) && item.state === 'open') loads.waiting.set(item.to_agent, loads.waiting.get(item.to_agent) + 1);
          }
          if (page.length < 100) break;
          after = page.at(-1).rowid;
        }
      }
      for (const items of loads.held.values()) items.sort(timeOrder);
      return loads;
    },
    openAddressedTo: id => bothJobs(current.openAddressedTo(id), `open = 1 AND ${jobFact('to_agent')} = ?`, [id], orderedJobs, Infinity, item => item.state !== 'finished' && item.to_agent === id),
    pendingAddressedTo: (ids, limit) => {
      if (!ids.length || finiteLimit(limit) === 0) return [];
      const currentRows = current.pendingAddressedTo(ids, limit);
      const olderRows = pendingFromOldTable(ids, limit);
      const selected = [...currentRows.map(item => ({ item, ...item })), ...olderRows]
        .sort(queueOrder).slice(0, finiteLimit(limit));
      const oldIds = selected.filter(row => !row.item).map(row => row.handoff_id);
      const oldValues = new Map(oldIds.length
        ? sql.exec('SELECT handoff_id, value FROM agent_handoffs WHERE handoff_id IN (SELECT value FROM json_each(?))', JSON.stringify(oldIds))
          .toArray().map(row => [row.handoff_id, JSON.parse(row.value)])
        : []);
      return selected.flatMap(row => row.item ? [row.item] : oldValues.has(row.handoff_id) ? [oldValues.get(row.handoff_id)] : []);
    },
    openForSource: id => bothJobs(current.openForSource(id), `open = 1 AND ${jobFact('input.arrived.source_id')} = ?`, [id], orderedJobs, Infinity,
      item => item.state !== 'finished' && item.input?.arrived?.source_id === id),
    unaddressedForSource: id => bothJobs(current.unaddressedForSource(id), `open = 1 AND ${jobFact('to_agent')} IS NULL AND ${jobFact('input.arrived.source_id')} = ?`, [id], orderedJobs, Infinity,
      item => item.state !== 'finished' && !item.to_agent && item.input?.arrived?.source_id === id),
    dependentsOf: id => bothJobs(current.dependentsOf(id), `open = 1 AND ${jobFact('depends_on')} <> '[]'`, [], orderedJobs, Infinity,
      item => item.state !== 'finished' && item.depends_on?.includes(id)),
    dependentsOfAny: ids => bothJobs(current.dependentsOfAny(ids), `open = 1 AND ${jobFact('depends_on')} <> '[]'`, [], orderedJobs, Infinity,
      item => item.state !== 'finished' && ids.some(id => item.depends_on?.includes(id))),
    // The take facts are only in the records: while any open job still waits in the old table they are not whole, so a take
    // reads open work (openQueue below, which adds those rows).
    // The reader facts are on the records only: with an open job still in the old table they are not whole.
    pendingForReader: (reader, limit) => unmovedOpenStart() === null ? current.pendingForReader(reader, limit) : null,
    takeable: { ...current.takeable, ready: () => unmovedOpenStart() === null && current.takeable.ready() },
    openQueue: ({ to_agent = null, nowIso, after = null, limit = Infinity, takeable = null }) => {
      const mark = after ? api.handoff(after) : null;
      if (after && !mark) return [];
      const later = item => !mark || queueOrder(item, mark) > 0;
      const currentRows = after && !shadows('handoff', after)
        ? current.openQueue({ to_agent, nowIso, limit: Infinity, takeable })
        : current.openQueue({ to_agent, nowIso, after, limit, takeable });
      const choice = to_agent
        ? `${jobFact('to_agent')} = ?`
        : `(${jobFact('to_agent')} IS NULL OR ${jobFact('prefer_until')} <= ?)`;
      return bothJobs(currentRows, `open = 1 AND ${choice}`, [to_agent ?? nowIso], priorityJobs, limit,
        item => item.state !== 'finished' && queueFits(item, to_agent, nowIso) && later(item));
    },
    waitingCount: (id, { most = Infinity } = {}) => {
      const kept = current.waitingCount(id, { most });
      return kept >= most ? kept : kept + handoffRows(`open = 1 AND ${jobFact('state')} = 'open' AND ${jobFact('to_agent')} = ?`, [id], '', most - kept,
        item => item.state === 'open' && item.to_agent === id, { unmovedOpenOnly: true }).length;
    },
    // { taskMap: true } answers only what the task map draws of each job (src/handoff-projection.mjs taskMapHandoff).
    fromMessage: (id, { taskMap = false } = {}) => drawnIf(taskMap, bothJobs(current.fromMessage(id, { taskMap }), `(${jobFact('input.arrived.message_id')} = ? OR ${jobFact('input.arrived.asked_id')} = ?)`, [id, id], orderedJobs, Infinity,
      item => item.input?.arrived?.message_id === id || item.input?.arrived?.asked_id === id)),
    // A dependency may be finished on the other side of the move. Read review
    // candidates in index order, but resolve each dependency through this bridge.
    nextReviewAt: nowIso => {
      const times = [current.nextReviewAt(nowIso, finished), earliestLegacyReview(nowIso)].filter(value => value !== null);
      return times.length ? times.sort(compareText)[0] : null;
    },
    // The due work of both sides, each side's dependencies resolved through this bridge, in review order.
    dueReviews: (nowIso, limit = Infinity) => {
      const size = finiteLimit(limit);
      if (size === 0) return [];
      // Reserve each side part of the reconciler's bounded page. If both reads advance by `size`, slicing their
      // concatenation could discard already-advanced legacy results whenever records supplied the earlier page.
      const currentLimit = Number.isFinite(size) ? Math.max(1, Math.ceil(size / 2)) : LEGACY_REVIEW_PAGE;
      const currentDue = current.dueReviews(nowIso, currentLimit, finished);
      const legacyLimit = Number.isFinite(size) ? Math.max(0, size - currentDue.length) : LEGACY_REVIEW_PAGE;
      return [...currentDue, ...dueLegacyReviews(nowIso, legacyLimit)]
        .sort((a, b) => compareText(reviewOf(a).review_at, reviewOf(b).review_at) || compareText(a.handoff_id, b.handoff_id))
        .slice(0, size);
    },
    reviewMark: () => current.reviewMark(),
    putReviewMark: after => current.putReviewMark(after),
    handedOnMetadataFromMany,
    handedOnIdsFromMany: ids => new Map([...handedOnMetadataFromMany(ids)].map(([id, children]) => [id, children.map(child => child.handoff_id)])),
    handedOnFrom: id => bothJobs(current.handedOnFrom(id), 'parent = ?', [id], orderedJobs, Infinity, item => item.parent_handoff_id === id),
    handedOnFromMany: (ids, { taskMap = false } = {}) => {
      const groups = new Map([...new Set(ids)].map(id => [id, []]));
      if (!groups.size) return groups;
      const selected = [...groups.keys()];
      const latest = [...current.handedOnFromMany(selected, { taskMap }).values()].flat();
      const together = bothJobs(latest, 'parent IN (SELECT value FROM json_each(?))', [JSON.stringify(selected)], orderedJobs,
        Infinity, item => groups.has(item.parent_handoff_id));
      for (const item of drawnIf(taskMap, together)) groups.get(item.parent_handoff_id).push(item);
      return groups;
    },
    newestHandoffs: (limit, { taskMap = false } = {}) => drawnIf(taskMap, bothJobs(current.newestHandoffs(limit, { taskMap }), '1 = 1', [], newestJobs, limit)),
    partsPage: (id, { before = null, limit } = {}) => {
      if (!exists('handoff')) return current.partsPage(id, { before, limit });
      const mark = before ? api.handoff(before) : null;
      if (before && (!mark || mark.parent_handoff_id !== id)) return [];
      const cursor = afterTime(mark, false);
      return bothJobs(current.partsPage(id, { before, limit, mark }), withAfter('parent = ?', cursor), [id, ...cursor.args], newestJobs, limit,
        item => item.parent_handoff_id === id && (!mark || timeOrder(item, mark) < 0));
    },
    finishedHandoffs: ({ before = null, limit, projection = null }) => {
      const selected = handoffProjection(projection);
      if (!exists('handoff')) return current.finishedHandoffs({ before, limit, projection: selected });
      const mark = before ? api.handoff(before) : null;
      if (before && !mark) return [];
      const cursor = afterTime(mark, false);
      const currentRows = before && !shadows('handoff', before)
        ? recordFinishedBefore(mark, limit)
        : current.finishedHandoffs({ before, limit });
      return bothJobs(currentRows, withAfter('open = 0', cursor), cursor.args, newestJobs, limit,
        item => item.state === 'finished' && (!mark || timeOrder(item, mark) < 0)).map(item => projectHandoff(item, selected));
    },

    deliverySecret: id => {
      const latest = current.deliverySecret(id);
      return latest !== null || shadows('secret', id) ? latest : older('secret', id)?.secret ?? null;
    },
    putDeliverySecret: (id, secret) => current.putDeliverySecret(id, secret),
    delivery: id => one('delivery', id, 'delivery'),
    putDelivery: item => { legacyNextDue = undefined; return current.putDelivery(item); },
    dueDeliveries: nowIso => bothWaitingDeliveries(current.dueDeliveries(nowIso), "state = 'waiting' AND next_at <= ?", [nowIso], 'next_at, event_id', 50,
      item => item.state === 'waiting' && item.next_at && item.next_at <= nowIso, { seekTail: true }),
    deadDeliveries: id => bothDeliveries(current.deadDeliveries(id), "agent_id = ? AND state = 'dead'", [id], 'event_id', Infinity,
      item => item.agent_id === id && item.state === 'dead'),
    deliveriesFor: id => bothDeliveries(current.deliveriesFor(id), `${deliveryFact('event.subject_id')} = ?`, [id], 'event_id', Infinity,
      item => item.event?.subject_id === id),
    waitingFor: (id, limit = Infinity) => {
      const currentCount = current.waitingFor(id, limit);
      const remaining = Number.isFinite(limit) ? Math.max(0, limit - currentCount) : Infinity;
      if (remaining === 0 || !exists('delivery')) return currentCount;
      const place = placeOf('agent_deliveries');
      if (place?.first_done) return currentCount;
      let after = place?.first_after ?? 0;
      let visible = 0;
      const indexed = hasIndex('agent_deliveries_agent') ? ' INDEXED BY agent_deliveries_agent' : '';
      for (;;) {
        // The agent index carries rowid after agent_id and state. A keyset page
        // avoids OFFSET rereading a growing waiting prefix on a busy account.
        const page = sql.exec(`SELECT rowid, event_id FROM agent_deliveries${indexed}
          WHERE agent_id = ? AND state = 'waiting' AND rowid > ? ORDER BY rowid LIMIT 100`, id, after).toArray();
        for (const row of page) {
          after = row.rowid;
          if (!shadows('delivery', row.event_id) && ++visible >= remaining) return currentCount + visible;
        }
        if (page.length < 100) return currentCount + visible;
      }
    },
    streamWaiting: id => bothWaitingDeliveries(current.streamWaiting(id), "agent_id = ? AND state = 'waiting' AND next_at IS NULL", [id], 'event_id', MAX_PULLED,
      item => item.agent_id === id && item.state === 'waiting' && !item.next_at),
    nextDeliveryAt: () => {
      const first = nextLegacyDelivery();
      const times = [current.nextDeliveryAt(), first ? Date.parse(first.next_at) : null].filter(value => value !== null);
      return times.length ? Math.min(...times) : null;
    },
    transaction: fn => current.transaction(fn),
  };
  return api;
}
