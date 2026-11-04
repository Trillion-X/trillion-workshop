import { tableGeneration } from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';
// A person's Workshop facts (`workshop_facts`: every version of a fact, appended; the newest per entity is current) and
// the index of what is current (`workshop_current`: one row per entity, the seq of its newest version).
//
// Every question asked of the facts is answered from `workshop_current`, never from the versions: a prefix is a range
// of entities, so a read costs the entities under it however many versions were ever written. A question about what is
// open or when the next one is due (a retry, a batch, a sign-in) is an index read over the few rows that are open, and
// a fact that ages out says when (`expires`), so it is let go in bounded pages instead of kept for ever.
//
// Invariants:
// - A fact is written in one place (`addWorkshopFact`), which appends its version and replaces its current row, in
//   the caller's transaction; a current row is only ever replaced by a newer version (its `seq`), so keeping again
//   changes nothing.
// - What a kind of fact keeps beside its value (`KINDS`) is worked out from its value when it is written and when a
//   store from before the index is filled, and nowhere else.
// - A store written before the index existed is filled once, a bounded page of entities at a time, before any question
//   is answered from the index; the page that was filled last is kept (`workshop_current_filled`), so a reset resumes.
// - Workshop runs (`task:`) keep their own index (src/workshop-tasks.mjs) and are not kept here.
const DAY = 86_400_000;
// How long a fact that is over (an event that was handled, a retry that was settled) is kept.
export const FINISHED_KEPT_MS = 30 * DAY;
// How many entities one page of filling reads.
const FILL_PAGE = 64;
const TASKS = 'task:';
const REFERENCE_PAGE = 100;
const SUMMARY_PAGE = 64;
const RELATED_PAGE = 64;
const SUMMARY_BYTES = 1024 * 1024;
const TIMING_KINDS = ['event-seen:', 'event-attempt:', 'event-count:'];
// These current-value families use the existing (kind,seq) index, but retain
// every historical version. They are deliberately separate from KINDS, whose
// event/control histories are pruned by the existing timing owner.
const SEQUENCE_PREFIXES = ['marketplace-install:'];
const INDEXED_SUMMARIES = [...TIMING_KINDS, ...SEQUENCE_PREFIXES];
const sequencePrefixOf = entity => SEQUENCE_PREFIXES.find(prefix => entity.startsWith(prefix)) ?? null;
// References a saved fact grants: both a connector and every use of that connector are needed to build its hosts.
const REFERENCES = { 'tool:': value => value?.status === 'deleted' ? [] : [value?.invoke?.connection, value?.invoke?.connects?.connection] };
const referenceKind = entity => Object.keys(REFERENCES).find(kind => entity.startsWith(kind));

export function prefixEnd(prefix) {
  const points = Array.from(prefix);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index].codePointAt(0);
    if (value === 0x10ffff) continue;
    // SQLite TEXT orders valid Unicode as UTF-8 bytes. Surrogates are not Unicode scalars.
    const next = value === 0xd7ff ? 0xe000 : value + 1;
    return points.slice(0, index).join('') + String.fromCodePoint(next);
  }
  return null;
}

const finite = value => (Number.isFinite(value) ? value : null);
const over = at => ({ expires: finite(at) === null ? null : at + FINISHED_KEPT_MS });
// Facts that are open until something finishes them: `due` is when they next need looking at (null once over), `scope`
// narrows a question to some of them, `expires` is when a finished one may be let go. `at` is when the version was written (ms).
// Only the newest version of these is ever read, so older ones are let go as the next is written.
const KINDS = {
  // An event that arrived: open while some rule on it is still to be tried again.
  'event-seen:': (value, at) => (value.pending ? { due: finite(value.retry_at) ?? 0, finite_due: finite(value.retry_at), scope: value.source_id ?? null,
    route_key: typeof value.event_payload?.route_key === 'string' ? value.event_payload.route_key : null } : over(at)),
  // A run an event started: open until the run is over, looked at a minute after it was due.
  'event-attempt:': (value, at) => (value.done ? over(at) : { due: finite(Date.parse(value.due_at) + 60_000), scope: value.source_id ?? null }),
  // Events gathered into one run: open while any are gathered.
  'event-batch:': value => (value.count ? { due: finite(Date.parse(value.opened_at) + value.every_minutes * 60_000) } : {}),
  'event-count:': (value, at) => over(at),
  // A sign-in waiting to be approved: open until it is done.
  'device-sign-in:': value => (value.done ? {} : { due: finite(value.next_at) }),
};
const kindOf = entity => Object.keys(KINDS).find(kind => entity.startsWith(kind)) ?? null;

// What this handle made in its current table generation (src/table-generation.mjs): the tables, the fill mark and the
// summaries already filled. A dropped generation's setup is never read again.
const setups = new WeakMap();
const setupOf = sql => {
  const generation = tableGeneration(sql);
  let setup = setups.get(sql);
  if (setup?.generation !== generation) setups.set(sql, setup = { generation, made: false, filled: false, summaries: new Set() });
  return setup;
};
/** The caller's transaction rolled back schema, a fill marker or a new current row. */
export function forgetWorkshopSetup(sql) {
  setups.delete(sql);
}
// Every table and index this owner makes. A store holding them all is confirmed by one read instead of one statement
// each, so a cold start or a new isolate's first use repeats none of them (test/schema-version-skips-index-retirement.test.mjs).
const SCHEMA = [
  'workshop_current',
  'workshop_current_open',
  'workshop_current_expiring',
  'workshop_current_newest',
  'workshop_current_filled',
  'workshop_current_timing',
  'workshop_current_timing_route_due',
  'workshop_current_timing_scope_due',
  'workshop_current_timing_due',
  'workshop_current_timing_expiring',
  'workshop_current_summaries_filled',
  'workshop_current_summaries_filled_sequence_revision',
  'workshop_references',
  'workshop_references_entity',
  'workshop_references_filled',
  'workshop_references_filled_pending',
];
function tables(sql) {
  if (setupOf(sql).made) return;
  const present = new Set(sql.exec(`SELECT name FROM sqlite_master WHERE name IN (${SCHEMA.map(() => '?').join(', ')})`, ...SCHEMA).toArray().map(row => row.name));
  const first = !present.has('workshop_current');
  if (present.size !== SCHEMA.length) {
    sql.exec('CREATE TABLE IF NOT EXISTS workshop_current (entity TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT, scope TEXT, due INTEGER, expires INTEGER) WITHOUT ROWID');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_open ON workshop_current (kind, due) WHERE due IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_expiring ON workshop_current (expires) WHERE expires IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_newest ON workshop_current (kind, seq) WHERE kind IS NOT NULL');
    sql.exec('CREATE TABLE IF NOT EXISTS workshop_current_filled (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT NOT NULL, done INTEGER NOT NULL)');
    // These indexes are created on a fresh empty projection, never built over the populated global current table
    // in an admission call. It belongs to this same fact owner and is maintained with every current fact write.
    sql.exec('CREATE TABLE IF NOT EXISTS workshop_current_timing (entity TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, scope TEXT, due REAL, route_key TEXT, finite_due REAL, expires REAL) WITHOUT ROWID');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_timing_route_due ON workshop_current_timing (kind, scope, route_key, finite_due, due) WHERE due IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_timing_scope_due ON workshop_current_timing (kind, scope, finite_due, due) WHERE due IS NOT NULL AND finite_due IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_timing_due ON workshop_current_timing (kind, due) WHERE due IS NOT NULL');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_timing_expiring ON workshop_current_timing (expires) WHERE expires IS NOT NULL');
    sql.exec("CREATE TABLE IF NOT EXISTS workshop_current_summaries_filled (kind TEXT PRIMARY KEY, after TEXT NOT NULL, done INTEGER NOT NULL, revision TEXT NOT NULL DEFAULT '') WITHOUT ROWID");
    sql.exec('CREATE TABLE IF NOT EXISTS workshop_references (kind TEXT NOT NULL, reference TEXT NOT NULL, entity TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, reference, entity)) WITHOUT ROWID');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_references_entity ON workshop_references (entity)');
    sql.exec('CREATE TABLE IF NOT EXISTS workshop_references_filled (kind TEXT PRIMARY KEY, after TEXT NOT NULL, done INTEGER NOT NULL) WITHOUT ROWID');
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_references_filled_pending ON workshop_references_filled (kind) WHERE done = 0');
  }
  if (!present.has('workshop_current_summaries_filled_sequence_revision')) {
    const columns = sql.exec('PRAGMA table_info(workshop_current_summaries_filled)').toArray();
    if (!columns.some(row => row.name === 'revision')) sql.exec("ALTER TABLE workshop_current_summaries_filled ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
    // This schema sentinel indexes only the tiny declared-kind marker table;
    // no index is built over a populated fact/current table on a cold request.
    sql.exec('CREATE INDEX IF NOT EXISTS workshop_current_summaries_filled_sequence_revision ON workshop_current_summaries_filled (kind,revision)');
  }
  // reads-ok: one primary-key probe per fixed declared summary kind.
  const summaryRows = sql.exec(`SELECT kind,revision FROM workshop_current_summaries_filled WHERE kind IN (${INDEXED_SUMMARIES.map(() => '?').join(', ')})`, ...INDEXED_SUMMARIES).toArray();
  const summarized = new Set(summaryRows.map(row => row.kind));
  for (const kind of TIMING_KINDS) {
    if (summarized.has(kind)) continue;
    const existing = sql.exec('SELECT 1 FROM workshop_facts WHERE entity >= ? AND entity < ? LIMIT 1', kind, prefixEnd(kind)).toArray().length;
    sql.exec('INSERT INTO workshop_current_summaries_filled (kind, after, done) VALUES (?, ?, ?)', kind, kind, existing ? 0 : 1);
  }
  for (const prefix of SEQUENCE_PREFIXES) {
    if (summaryRows.some(row => row.kind === prefix && row.revision)) continue;
    const existing = sql.exec('SELECT 1 FROM workshop_facts WHERE entity >= ? AND entity < ? LIMIT 1', prefix, prefixEnd(prefix)).toArray().length;
    sql.exec(`INSERT INTO workshop_current_summaries_filled (kind,after,done,revision) VALUES (?,?,?,?)
      ON CONFLICT(kind) DO UPDATE SET after=excluded.after,done=excluded.done,revision=excluded.revision`,
    prefix, '', existing ? 0 : 1, crypto.randomUUID());
  }
  for (const kind of Object.keys(REFERENCES)) {
    if (!sql.exec('SELECT 1 FROM workshop_references_filled WHERE kind = ? LIMIT 1', kind).toArray().length) {
      const existing = sql.exec('SELECT 1 FROM workshop_facts WHERE entity >= ? AND entity < ? LIMIT 1', kind, prefixEnd(kind)).toArray().length;
      sql.exec('INSERT INTO workshop_references_filled (kind, after, done) VALUES (?, ?, ?)', kind, kind, existing ? 0 : 1);
    }
  }
  // A store with no facts yet has nothing to fill: every fact it will hold is kept here as it is written.
  if (first && !sql.exec('SELECT 1 FROM workshop_facts LIMIT 1').toArray().length) {
    sql.exec("INSERT OR IGNORE INTO workshop_current_filled (id, after, done) VALUES (1, '', 1)");
    setupOf(sql).filled = true;
  }
  setupOf(sql).made = true;
}

function keepReferences(sql, entity, seq, value) {
  const kind = referenceKind(entity);
  if (!kind) return;
  // A bounded historical page may be older than a write made meanwhile. Never replace that newer index.
  const current = sql.exec('SELECT seq FROM workshop_current WHERE entity = ? LIMIT 1', entity).toArray()[0];
  if (current && current.seq > seq) return;
  sql.exec('DELETE FROM workshop_references WHERE entity = ?', entity);
  const references = new Set(REFERENCES[kind](value).filter(ref => typeof ref === 'string' && ref.trim()));
  for (const reference of references) sql.exec('INSERT INTO workshop_references (kind, reference, entity, seq) VALUES (?, ?, ?, ?)', kind, reference, entity, seq);
}

function keepTiming(sql, entity, seq, at, value) {
  const kind = kindOf(entity);
  if (!TIMING_KINDS.includes(kind)) return;
  const held = KINDS[kind](value ?? {}, Date.parse(at));
  sql.exec(`INSERT INTO workshop_current_timing (entity, seq, kind, scope, due, route_key, finite_due, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (entity) DO UPDATE SET seq = excluded.seq, kind = excluded.kind, scope = excluded.scope, due = excluded.due,
      route_key = excluded.route_key, finite_due = excluded.finite_due, expires = excluded.expires WHERE excluded.seq >= workshop_current_timing.seq`,
  entity, seq, kind, typeof held.scope === 'string' ? held.scope : null, held.due ?? null, held.route_key ?? null,
  kind === 'event-seen:' ? held.finite_due ?? null : held.due ?? null, held.expires ?? null);
}

function keep(sql, entity, seq, at, value, { prune = true } = {}) {
  if (entity.startsWith(TASKS)) return;
  const kind = kindOf(entity);
  const held = kind ? KINDS[kind](value ?? {}, Date.parse(at)) : {};
  sql.exec(`INSERT INTO workshop_current (entity, seq, kind, scope, due, expires) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (entity) DO UPDATE SET seq = excluded.seq, kind = excluded.kind, scope = excluded.scope, due = excluded.due, expires = excluded.expires
    WHERE excluded.seq > workshop_current.seq`, entity, seq, kind ?? sequencePrefixOf(entity), held.scope ?? null, held.due ?? null, held.expires ?? null);
  keepTiming(sql, entity, seq, at, value);
  if (kind && prune) sql.exec('DELETE FROM workshop_facts WHERE entity = ? AND seq < ?', entity, seq);
}

// Current metadata needs only these fields. Preserve their JSON types so legacy values have exactly the same
// truthiness, finite-number checks and Date.parse coercions as a new write; event bodies never leave SQLite.
const FILL_FIELDS = {
  'event-seen:': ['pending', 'retry_at', 'source_id', 'event_payload.route_key'],
  'event-attempt:': ['done', 'due_at', 'source_id'],
  'event-batch:': ['count', 'opened_at', 'every_minutes'],
  'device-sign-in:': ['done', 'next_at'],
};
function metadataValue(sql, row) {
  const fields = FILL_FIELDS[kindOf(row.entity)];
  if (!fields) return {};
  const properties = fields.filter(field => !field.includes('.')).map(field => `'${field}', json(value -> '$.${field}')`);
  if (fields.includes('event_payload.route_key')) properties.push("'event_payload', json_object('route_key', json(value -> '$.event_payload.route_key'))");
  const types = fields.map(field => `json_type(value, '$.${field}')`);
  const scalar = sql.exec(`SELECT json_object(${properties.join(', ')}) AS scalar, json_array(${types.join(', ')}) AS types FROM workshop_facts WHERE seq = ? LIMIT 1`, row.seq).toArray()[0];
  const value = JSON.parse(scalar.scalar);
  JSON.parse(scalar.types).forEach((type, index) => { if (type === null && !fields[index].includes('.')) delete value[fields[index]]; });
  return value;
}
const indexingRetry = field => Object.assign(new Error('Your saved work is still being indexed. Try again shortly.'), { retry_at: Date.now() + 1000, [field]: true });

// Scalar timing questions never call the old complete-value fill. Advance only this kind's metadata, at most one
// page and one MiB of JSON processing per call (one larger legacy record can still make progress). SQLite I/O and
// CPU are not strictly byte bounded by this budget. Only scalar fields leave SQLite;
// event bodies stay in their original facts. The durable cursor resumes after reset; concurrent newer writes win.
function fillSummary(sql, kind) {
  tables(sql);
  if (!TIMING_KINDS.includes(kind)) throw new Error(`${kind} has no scalar timing summary.`);
  const ready = setupOf(sql).summaries;
  if (ready.has(kind)) return;
  const mark = sql.exec('SELECT after, done FROM workshop_current_summaries_filled WHERE kind = ? LIMIT 1', kind).toArray()[0];
  if (mark.done) { ready.add(kind); return; }
  // Seek directly past each entity and then to its newest seq. GROUP BY/MAX would visit every old version of
  // the selected entities even though only64entities were returned.
  const page = sql.exec(`WITH RECURSIVE picked(entity, position) AS (
    SELECT (SELECT entity FROM workshop_facts WHERE entity > ? AND entity < ? ORDER BY entity LIMIT 1), 1
    UNION ALL
    SELECT (SELECT entity FROM workshop_facts WHERE entity > picked.entity AND entity < ? ORDER BY entity LIMIT 1), position + 1
      FROM picked WHERE entity IS NOT NULL AND position < ?
    ) SELECT f.entity, f.seq, f.at FROM picked JOIN workshop_facts f ON
      f.seq = (SELECT seq FROM workshop_facts WHERE entity = picked.entity ORDER BY seq DESC LIMIT 1)
    ORDER BY picked.position`, mark.after, prefixEnd(kind), prefixEnd(kind), SUMMARY_PAGE).toArray();
  let bytes = 0, processed = 0, after = mark.after;
  for (const row of page) {
    // Size only the next exact row; measuring a whole page could itself open dozens of large legacy bodies.
    const size = kind === 'event-count:' ? 0 : sql.exec('SELECT length(CAST(value AS BLOB)) AS bytes FROM workshop_facts WHERE seq = ? LIMIT 1', row.seq).toArray()[0].bytes;
    if (processed && bytes + size > SUMMARY_BYTES) break;
    const fields = kind === 'event-seen:'
      ? "json_object('pending', CASE WHEN json_type(value, '$.pending') IN ('array', 'object') THEN 1 ELSE json_extract(value, '$.pending') END, 'source_id', CASE WHEN json_type(value, '$.source_id') = 'text' THEN json_extract(value, '$.source_id') END, 'retry_at', CASE WHEN json_type(value, '$.retry_at') IN ('integer', 'real') THEN json_extract(value, '$.retry_at') END, 'event_payload', json_object('route_key', CASE WHEN json_type(value, '$.event_payload.route_key') = 'text' THEN json_extract(value, '$.event_payload.route_key') END))"
      : "json_object('done', CASE WHEN json_type(value, '$.done') IN ('array', 'object') THEN 1 ELSE json_extract(value, '$.done') END, 'source_id', CASE WHEN json_type(value, '$.source_id') = 'text' THEN json_extract(value, '$.source_id') END, 'due_at', json(value -> '$.due_at'))";
    const value = kind === 'event-count:' ? {} : JSON.parse(sql.exec(`SELECT ${fields} AS scalar FROM workshop_facts WHERE seq = ? LIMIT 1`, row.seq).toArray()[0].scalar);
    // No complete-current fill or historical deletion is performed by a scalar backfill.
    keepTiming(sql, row.entity, row.seq, row.at, value);
    bytes += size; processed += 1; after = row.entity;
  }
  const done = processed === page.length && page.length < SUMMARY_PAGE;
  sql.exec('UPDATE workshop_current_summaries_filled SET after = ?, done = ? WHERE kind = ?', after, done ? 1 : 0, kind);
  if (done) { ready.add(kind); return; }
  throw Object.assign(new Error('Incoming event retries are still being indexed. Try again shortly.'), { retry_at: Date.now() + 1000, workshop_summary_pending: true });
}

// Each declared scope/route probes the first row of its own covering index. An IN plus global sort or MIN would
// walk all matching events; these correlated LIMIT 1 probes cost the declared keys, never their pending backlogs.
function nextSummary(sql, kind, { scopes, routes, pending = false, from_due } = {}) {
  fillSummary(sql, kind);
  const scopeList = scopes === undefined ? null : [...new Set(scopes)];
  const routeList = routes === undefined ? null : [...new Set(routes)];
  if (scopeList?.some(scope => typeof scope !== 'string') || routeList?.some(route => typeof route !== 'string')) throw new Error('Timing scopes and routes must be text.');
  if (scopeList?.length === 0 || routeList?.length === 0) return [{ at: null, pending: false }];
  if (routeList && scopeList?.length !== 1) throw new Error('A route timing question names one source.');
  if (routeList) {
    const column = pending ? '1' : 'finite_due';
    const order = pending ? '' : ' AND finite_due IS NOT NULL ORDER BY finite_due';
    const result = sql.exec(`SELECT ${pending ? 'MAX(at)' : 'MIN(at)'} AS at FROM (SELECT
      (SELECT ${column} FROM workshop_current_timing WHERE kind = ? AND scope = ? AND route_key = keys.value AND due IS NOT NULL${order} LIMIT 1) AS at
      FROM json_each(?) keys)`, kind, scopeList[0], JSON.stringify(routeList)).toArray()[0];
    return [{ at: pending ? null : result.at, pending: pending && result.at !== null }];
  }
  if (scopeList) {
    const result = sql.exec(`SELECT MIN(at) AS at FROM (SELECT
      (SELECT finite_due FROM workshop_current_timing WHERE kind = ? AND scope = keys.value AND due IS NOT NULL AND finite_due IS NOT NULL${from_due === undefined ? '' : ' AND finite_due >= ?'} ORDER BY finite_due LIMIT 1) AS at
      FROM json_each(?) keys)`, kind, ...(from_due === undefined ? [] : [from_due]), JSON.stringify(scopeList)).toArray()[0];
    return [{ at: result.at, pending: false }];
  }
  const result = sql.exec('SELECT due AS at FROM workshop_current_timing WHERE kind = ? AND due IS NOT NULL ORDER BY due LIMIT 1', kind).toArray()[0];
  return [{ at: result?.at ?? null, pending: false }];
}

// One page per question, never an unbounded migration inside the scheduler's pre-budget gathering. The existing
// cursor commits completed entities only; readers refuse partial results and the existing scheduler keeps the retry.
function fill(sql) {
  tables(sql);
  if (setupOf(sql).filled) return;
  // reads-ok: the one-row fill mark
  const mark = sql.exec('SELECT after, done FROM workshop_current_filled WHERE id = 1').toArray()[0];
  if (mark?.done) { setupOf(sql).filled = true; return; }
  let after = mark?.after ?? '', processed = 0, bytes = 0, pruning = false;
  const page = sql.exec(`WITH RECURSIVE workshop_fill(entity, position) AS (
    SELECT (SELECT entity FROM workshop_facts WHERE entity > ? ORDER BY entity LIMIT 1), 1
    UNION ALL
    SELECT (SELECT entity FROM workshop_facts WHERE entity > workshop_fill.entity ORDER BY entity LIMIT 1), position + 1
      FROM workshop_fill WHERE entity IS NOT NULL AND position < ?
    ) SELECT f.entity, f.seq, f.at FROM workshop_fill JOIN workshop_facts f ON
      f.seq = (SELECT seq FROM workshop_facts WHERE entity = workshop_fill.entity ORDER BY seq DESC LIMIT 1)
    ORDER BY workshop_fill.position`, after, FILL_PAGE).toArray();
  for (const row of page) {
    if (row.entity.startsWith(TASKS)) { processed += 1; after = row.entity; continue; }
    const needsJson = Boolean(FILL_FIELDS[kindOf(row.entity)]);
    const size = needsJson ? sql.exec('SELECT length(CAST(value AS BLOB)) AS bytes FROM workshop_facts WHERE seq = ? LIMIT 1', row.seq).toArray()[0]?.bytes ?? 0 : 0;
    if (processed && bytes + size > SUMMARY_BYTES) break;
    keep(sql, row.entity, row.seq, row.at, needsJson ? metadataValue(sql, row) : {}, { prune: false });
    processed += 1; bytes += size;
    if (kindOf(row.entity)) {
      // Retain the old pruning result while bounding each deletion. A large version history keeps this entity
      // ahead of the cursor until its old versions are gone, so a reset resumes without another migration owner.
      sql.exec('DELETE FROM workshop_facts WHERE seq IN (SELECT seq FROM workshop_facts WHERE entity = ? AND seq < ? ORDER BY seq LIMIT ?)', row.entity, row.seq, FILL_PAGE);
      pruning = Boolean(sql.exec('SELECT 1 FROM workshop_facts WHERE entity = ? AND seq < ? LIMIT 1', row.entity, row.seq).toArray().length);
      if (pruning) break;
    }
    after = row.entity;
  }
  const done = !pruning && processed === page.length && page.length < FILL_PAGE;
  sql.exec('INSERT INTO workshop_current_filled (id, after, done) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET after = excluded.after, done = excluded.done', after, done ? 1 : 0);
  if (!done) throw indexingRetry('workshop_current_pending');
  setupOf(sql).filled = true;
  // Only a pass that started at the beginning refreshed every summary. An old interrupted full fill may have
  // indexed its earlier rows before this projection existed; its resumed tail must not mark those summaries ready.
  if (!mark?.after) {
    sql.exec(`UPDATE workshop_current_summaries_filled SET done = 1 WHERE kind IN (${TIMING_KINDS.map(() => '?').join(', ')})`, ...TIMING_KINDS);
    setupOf(sql).summaries = new Set(TIMING_KINDS);
  }
}

const sequencePrefix = prefix => {
  if (!SEQUENCE_PREFIXES.includes(prefix)) throw Object.assign(new Error('Choose a declared current sequence prefix.'), { status: 400 });
  return prefix;
};
const sequencePending = () => Object.assign(indexingRetry('workshop_sequence_pending'), { status: 503 });
const sequenceChanged = () => Object.assign(new Error('The saved sequence changed. Restart from its first page.'), { status: 409, workshop_sequence_changed: true });
const sequenceMark = (sql, prefix) => sql.exec('SELECT after,done,revision FROM workshop_current_summaries_filled WHERE kind=? LIMIT 1', prefix).toArray()[0];

// Reclassify only the current positions of this declared family. A source that
// already completed the old global current index still needs this bounded pass.
// No fact bodies are opened and no original historical version is removed.
function fillSequence(sql, prefix) {
  try { fill(sql); }
  catch (error) { if (error.workshop_current_pending) { error.status = 503; error.workshop_sequence_pending = true; } throw error; }
  const mark = sequenceMark(sql, prefix);
  if (mark?.done) return;
  if (!mark?.revision) throw sequencePending();
  const rows = sql.exec('SELECT entity,seq FROM workshop_current WHERE entity>=? AND entity>? AND entity<? ORDER BY entity LIMIT ?',
    prefix, mark.after, prefixEnd(prefix), FILL_PAGE).toArray();
  for (const row of rows) sql.exec('UPDATE workshop_current SET kind=? WHERE entity=? AND seq=? AND (kind IS NULL OR kind!=?)', prefix, row.entity, row.seq, prefix);
  const done = rows.length < FILL_PAGE;
  sql.exec('UPDATE workshop_current_summaries_filled SET after=?,done=? WHERE kind=?', rows.at(-1)?.entity ?? mark.after, done ? 1 : 0, prefix);
  if (!done) throw sequencePending();
}

function changeSequenceRevision(sql, { entity, prefix }) {
  for (const kind of SEQUENCE_PREFIXES) {
    const touches = entity !== undefined ? entity.startsWith(kind) : prefix.startsWith(kind) || kind.startsWith(prefix);
    if (touches) sql.exec('UPDATE workshop_current_summaries_filled SET revision=? WHERE kind=?', crypto.randomUUID(), kind);
  }
}

/** A synchronous bounded final fence. It never advances a maintenance page. */
export function workshopValuesSequenceRevision(sql, prefix) {
  sequencePrefix(prefix); tables(sql);
  // Read the durable readiness marker as well as the token. Handle-local setup
  // flags cannot bless an incomplete durable index. Physical carry activation
  // and its actual generation remain the native caller's independent gate.
  if (!sql.exec('SELECT done FROM workshop_current_filled WHERE id=1 LIMIT 1').toArray()[0]?.done) throw sequencePending();
  const mark = sequenceMark(sql, prefix);
  if (!mark?.done || !mark.revision) throw sequencePending();
  return mark.revision;
}

/** Current values in original ascending latest-write sequence, one raw page. */
export function workshopValuesSequencePage(sql, prefix, { after_seq = 0, limit = FILL_PAGE, revision } = {}) {
  sequencePrefix(prefix);
  if (!Number.isSafeInteger(after_seq) || after_seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > FILL_PAGE
    || revision !== undefined && (typeof revision !== 'string' || !revision) || after_seq > 0 && revision === undefined)
    throw Object.assign(new Error('Read one current sequence page with its original revision and at most64 rows.'), { status: 400 });
  fillSequence(sql, prefix);
  const current = workshopValuesSequenceRevision(sql, prefix);
  if (revision !== undefined && revision !== current) throw sequenceChanged();
  const positions = sql.exec('SELECT entity,seq FROM workshop_current WHERE kind=? AND seq>? ORDER BY seq LIMIT ?', prefix, after_seq, limit + 1).toArray();
  const selected = positions.slice(0, limit);
  const values = selected.length ? sql.exec('SELECT seq,entity,value FROM workshop_facts WHERE seq IN (SELECT value FROM json_each(?)) LIMIT ?', JSON.stringify(selected.map(row => row.seq)), selected.length).toArray() : [];
  const bySeq = new Map(values.map(row => [row.seq, row]));
  const rows = selected.map(row => {
    const fact = bySeq.get(row.seq);
    if (!fact || fact.entity !== row.entity) throw sequenceChanged();
    return { entity: row.entity, seq: row.seq, value: JSON.parse(fact.value) };
  });
  if (workshopValuesSequenceRevision(sql, prefix) !== current) throw sequenceChanged();
  const complete = positions.length <= limit;
  return { rows, revision: current, next_after_seq: complete ? null : selected.at(-1).seq, complete };
}

/** The existing alarm advances pending current and scalar indexes one page, even on an otherwise idle account. */
export function workshopCurrentIndex(sql, { transaction = fn => fn(), now = () => Date.now() } = {}) {
  const pending = () => {
    tables(sql);
    if (!sql.exec('SELECT done FROM workshop_current_filled WHERE id = 1 LIMIT 1').toArray()[0]?.done) return { current: true };
    // This owner advances only its declared timing/sequence kinds. Seek their primary keys rather than scanning any
    // unrelated/obsolete marker a legacy layout may have left behind.
    return sql.exec(`SELECT kind FROM workshop_current_summaries_filled WHERE kind IN (${INDEXED_SUMMARIES.map(() => '?').join(', ')}) AND done = 0 ORDER BY kind LIMIT 1`, ...INDEXED_SUMMARIES).toArray()[0] ?? null;
  };
  return {
    nextAt: () => pending() ? now() : null,
    step: () => transaction(() => {
      const mark = pending();
      if (!mark) return { done: true };
      // An incomplete page is successful progress. Catch its typed refusal inside the transaction so its cursor
      // commits; a different failure still rolls the page back and clears the setup cache through the caller.
      try { if (mark.current) fill(sql); else if (SEQUENCE_PREFIXES.includes(mark.kind)) fillSequence(sql, mark.kind); else fillSummary(sql, mark.kind); }
      catch (error) { if (!error.workshop_current_pending && !error.workshop_summary_pending && !error.workshop_sequence_pending) throw error; }
      return { done: !pending() };
    }),
  };
}

/** Append a version of a fact and make it the current one. → { seq, at }. Call inside the transaction that holds the caller's other writes. */
export function addWorkshopFact(sql, entity, value, at = new Date().toISOString()) {
  try {
    tables(sql);
    const { seq } = sql.exec('INSERT INTO workshop_facts (at, entity, value) VALUES (?, ?, ?) RETURNING seq', at, entity, JSON.stringify(value)).toArray()[0];
    keep(sql, entity, seq, at, value);
    keepReferences(sql, entity, seq, value);
    if (sequencePrefixOf(entity)) changeSequenceRevision(sql, { entity });
    return { seq, at };
  } catch (error) {
    // A first write may create the indexes inside its caller's transaction. A failed write rolls those tables back;
    // discard only the in-memory setup flags so the retry creates them again, never keep a false successful setup.
    forgetWorkshopSetup(sql);
    throw error;
  }
}

/** Keep `value` as a plain fact's only version → { seq, at }: a fact with no kind, sequence or references (whose readers read
 * only its newest version) is rewritten in place, one statement and one row, instead of appending a version nothing reads
 * again; a fact not kept yet, or one of those, is added. Call inside the transaction that holds the caller's other writes. */
export function replaceWorkshopFact(sql, entity, value, at = new Date().toISOString()) {
  if (kindOf(entity) || sequencePrefixOf(entity) || referenceKind(entity) || entity.startsWith(TASKS)) return addWorkshopFact(sql, entity, value, at);
  const kept = sql.exec('UPDATE workshop_facts SET at = ?, value = ? WHERE seq = (SELECT seq FROM workshop_facts WHERE entity = ? ORDER BY seq DESC LIMIT 1) RETURNING seq',
    at, JSON.stringify(value), entity).toArray()[0];
  return kept ? { seq: kept.seq, at } : addWorkshopFact(sql, entity, value, at);
}

/** Forget every version of one fact, or of every fact under a prefix. */
export function forgetWorkshopFacts(sql, { entity, prefix }) {
  tables(sql);
  if (entity !== undefined) {
    if (sequencePrefixOf(entity)) changeSequenceRevision(sql, { entity });
    sql.exec('DELETE FROM workshop_facts WHERE entity = ?', entity);
    sql.exec('DELETE FROM workshop_current WHERE entity = ?', entity);
    sql.exec('DELETE FROM workshop_current_timing WHERE entity = ?', entity);
    sql.exec('DELETE FROM workshop_references WHERE entity = ?', entity);
    return;
  }
  changeSequenceRevision(sql, { prefix });
  const [from, to] = rangeOf(prefix);
  sql.exec('DELETE FROM workshop_facts WHERE entity >= ? AND entity < ?', from, to);
  sql.exec('DELETE FROM workshop_current WHERE entity >= ? AND entity < ?', from, to);
  sql.exec('DELETE FROM workshop_current_timing WHERE entity >= ? AND entity < ?', from, to);
  sql.exec('DELETE FROM workshop_references WHERE entity >= ? AND entity < ?', from, to);
}

/** Current values that name one reference, in entity order. Questions never build the historical index. */
export function workshopReferencedValues(sql, kind, reference) {
  if (!REFERENCES[kind]) throw new Error(`${kind} has no declared references.`);
  tables(sql);
  const done = sql.exec('SELECT done FROM workshop_references_filled WHERE kind = ? LIMIT 1', kind).toArray()[0]?.done;
  if (done) {
    // reads-ok: every relevant value for one exact declared reference, never the unrelated catalog
    return sql.exec('SELECT f.value FROM workshop_references r JOIN workshop_facts f ON f.seq = r.seq WHERE r.kind = ? AND r.reference = ? ORDER BY r.entity', kind, reference).toArray().map(row => JSON.parse(row.value));
  }
  const currentReady = sql.exec('SELECT done FROM workshop_current_filled WHERE id = 1 LIMIT 1').toArray()[0]?.done;
  if (currentReady) {
    // reads-ok: transitional selection of one reference from current rows; no version history or unrelated bodies
    return sql.exec(`SELECT f.value FROM workshop_current c JOIN workshop_facts f ON f.seq = c.seq
      WHERE c.entity >= ? AND c.entity < ? AND COALESCE(json_extract(f.value, '$.status'), '') != 'deleted' AND
        (json_extract(f.value, '$.invoke.connection') = ? OR json_extract(f.value, '$.invoke.connects.connection') = ?) ORDER BY c.entity`,
    kind, prefixEnd(kind), reference, reference).toArray().map(row => JSON.parse(row.value));
  }
  // While the bounded alarm fill is outstanding, SQL selects the same newest relevant rows. Unrelated bodies are
  // never returned, and partial migration cannot silently remove an older connector's grant.
  // reads-ok: transitional exact-reference selection; the only historical scan retires after bounded alarm filling
  return sql.exec(`SELECT f.value FROM workshop_facts f JOIN
    (SELECT entity, MAX(seq) AS seq FROM workshop_facts WHERE entity >= ? AND entity < ? GROUP BY entity) newest ON newest.seq = f.seq
    WHERE COALESCE(json_extract(f.value, '$.status'), '') != 'deleted' AND
      (json_extract(f.value, '$.invoke.connection') = ? OR json_extract(f.value, '$.invoke.connects.connection') = ?) ORDER BY f.entity`,
  kind, prefixEnd(kind), reference, reference).toArray().map(row => JSON.parse(row.value));
}

/** The existing scheduler fills old reference rows one bounded page per wake, resuming after a reset. */
export function workshopReferenceIndex(sql, { transaction = fn => fn(), now = () => Date.now() } = {}) {
  tables(sql);
  let finished = false;
  const pending = () => sql.exec('SELECT kind, after FROM workshop_references_filled WHERE done = 0 ORDER BY kind LIMIT 1').toArray()[0] ?? null;
  return {
    nextAt: () => {
      if (finished) return null;
      if (pending()) return now();
      finished = true;
      return null;
    },
    step() {
      if (finished) return { done: true, indexed: 0 };
      const mark = pending();
      if (!mark) { finished = true; return { done: true, indexed: 0 }; }
      const result = transaction(() => {
        const currentReady = sql.exec('SELECT done FROM workshop_current_filled WHERE id = 1 LIMIT 1').toArray()[0]?.done;
        const page = currentReady
          ? sql.exec(`SELECT c.entity, c.seq, json_extract(f.value, '$.status') AS status,
            json_extract(f.value, '$.invoke.connection') AS connection, json_extract(f.value, '$.invoke.connects.connection') AS connects
            FROM workshop_current c JOIN workshop_facts f ON f.seq = c.seq
            WHERE c.entity > ? AND c.entity < ? ORDER BY c.entity LIMIT ?`, mark.after, prefixEnd(mark.kind), REFERENCE_PAGE).toArray()
          : sql.exec(`SELECT f.entity, f.seq, json_extract(f.value, '$.status') AS status,
            json_extract(f.value, '$.invoke.connection') AS connection, json_extract(f.value, '$.invoke.connects.connection') AS connects FROM workshop_facts f JOIN
            (SELECT entity, MAX(seq) AS seq FROM workshop_facts WHERE entity > ? AND entity < ? GROUP BY entity ORDER BY entity LIMIT ?) newest
            ON newest.seq = f.seq ORDER BY f.entity`, mark.after, prefixEnd(mark.kind), REFERENCE_PAGE).toArray();
        for (const row of page) keepReferences(sql, row.entity, row.seq, { status: row.status, invoke: { connection: row.connection, connects: { connection: row.connects } } });
        const done = page.length < REFERENCE_PAGE;
        sql.exec('UPDATE workshop_references_filled SET after = ?, done = ? WHERE kind = ?', page.at(-1)?.entity ?? mark.after, done ? 1 : 0, mark.kind);
        return { done: !pending(), indexed: page.length };
      });
      finished = result.done;
      return result;
    },
  };
}

// The entities under a prefix: every one sorts at or after the prefix and before `prefixEnd`. A prefix with no end
// (every character the largest) is the rest of the entities.
const rangeOf = prefix => [prefix, prefixEnd(prefix) ?? '\u{10ffff}'.repeat(8)];
const refuseTasks = prefix => {
  if (prefix.startsWith(TASKS)) throw new Error(`The facts under ${prefix} are Workshop runs, read through src/workshop-tasks.mjs.`);
};
const joined = 'FROM workshop_current c JOIN workshop_facts f ON f.seq = c.seq';

/**
 * The current value of every entity under a prefix, oldest write first.
 * `newest: n`  only the n entities written last (the prefix must be a kind in KINDS).
 * `open: { from_due, due_by, scopes, limit }`  only the open ones (a kind in KINDS), earliest due first, due at or after
 *                                    `from_due` and at or before `due_by` (ms), for those scopes, at most `limit`.
 * `shown: { drop, clip }`  with `newest` or `open`, each value comes without its top-level keys in `drop` and with the
 *                                    text under a key in `clip` ({ key: most characters }) cut to that. It is done in SQL,
 *                                    so what is left out is never read into memory (a pending event keeps its whole
 *                                    payload for its retry, up to a megabyte).
 * `next: { scopes?, routes?, pending?, from_due? }`  one scalar `{ at, pending }`, using indexed first-row probes.
 *                                    `routes` names one scope; `pending` asks whether any route has an open fact.
 *                                    A legacy summary advances one bounded page and refuses with a known retry until ready.
 */
export function workshopValues(sql, prefix, { newest, open, shown, next, containing } = {}) {
  refuseTasks(prefix);
  if (next) return nextSummary(sql, prefix, next);
  // Raw facts remain authoritative for every current value. An absent plain prefix is already complete,
  // even while unrelated legacy kinds are being indexed. Never memoize absence: a later legacy or current
  // writer can add facts under it. Ready readers keep their existing one-statement projection path.
  if (newest === undefined && !open && !setupOf(sql).filled) {
    const [from, to] = rangeOf(prefix);
    if (!sql.exec('SELECT 1 FROM workshop_facts WHERE entity >= ? AND entity < ? LIMIT 1', from, to).toArray().length) return [];
  }
  fill(sql);
  if (newest !== undefined) {
    const rows = sql.exec(`SELECT ${shownValue('f.value', shown)} AS value ${joined} WHERE c.kind = ? ORDER BY c.seq DESC LIMIT ?`, kindFor(prefix), newest).toArray();
    return rows.reverse().map(row => JSON.parse(row.value));
  }
  if (open) {
    const scopes = open.scopes ? [...open.scopes] : null;
    if (scopes && !scopes.length) return [];
    const rows = sql.exec(`SELECT ${shownValue('f.value', shown)} AS value ${joined} WHERE c.kind = ? AND c.due IS NOT NULL${open.from_due === undefined ? '' : ' AND c.due >= ?'}${open.due_by === undefined ? '' : ' AND c.due <= ?'}${scopes ? ` AND c.scope IN (${scopes.map(() => '?').join(', ')})` : ''}
      ORDER BY c.due LIMIT ?`, kindFor(prefix), ...(open.from_due === undefined ? [] : [open.from_due]), ...(open.due_by === undefined ? [] : [open.due_by]), ...(scopes ?? []), open.limit ?? -1).toArray();
    return rows.map(row => JSON.parse(row.value));
  }
  const [from, to] = rangeOf(prefix);
  if (containing) {
    if (!/^\w+$/.test(containing.field) || typeof containing.value !== 'string') throw new Error('Choose a stored list field and its text member.');
    // Select current related bodies in SQL. Unrelated or superseded definitions never enter the isolate merely to
    // answer the lineage of one record. The same current-index readiness and literal prefix rules still apply.
    const rows = [];
    let after = 0;
    for (;;) {
      const page = sql.exec(`SELECT c.seq, f.value ${joined} WHERE c.entity >= ? AND c.entity < ? AND c.seq > ?
        AND json_type(f.value, '$.${containing.field}') = 'array'
        AND EXISTS (SELECT 1 FROM json_each(f.value, '$.${containing.field}') member WHERE member.value = ?) ORDER BY c.seq LIMIT ?`,
        from, to, after, containing.value, RELATED_PAGE).toArray();
      for (const row of page) rows.push(JSON.parse(row.value));
      if (page.length < RELATED_PAGE) break;
      after = page.at(-1).seq;
    }
    return rows;
  }
  return sql.exec(`SELECT f.value ${joined} WHERE c.entity >= ? AND c.entity < ? ORDER BY c.seq`, from, to).toArray().map(row => JSON.parse(row.value));
}

// The SQL that reads a fact's value as `shown` says (workshopValues): keys left out, text cut. Keys are field names the
// caller wrote in code, never input, and are refused here unless they are plain words.
function shownValue(column, { drop = [], clip = {} } = {}) {
  const key = name => {
    if (!/^\w+$/.test(name)) throw new Error(`${name} is not a field name to leave out or cut.`);
    return `'$.${name}'`;
  };
  let value = drop.length ? `json_remove(${column}, ${drop.map(key).join(', ')})` : column;
  for (const [name, most] of Object.entries(clip)) {
    if (!Number.isInteger(most) || most < 0) throw new Error(`${name} is cut to a number of characters.`);
    value = `CASE WHEN json_type(${value}, ${key(name)}) = 'text' THEN json_set(${value}, ${key(name)}, substr(json_extract(${value}, ${key(name)}), 1, ${most})) ELSE ${value} END`;
  }
  return value;
}

const kindFor = prefix => {
  if (!KINDS[prefix]) throw new Error(`${prefix} is not a kind of fact that is open or listed newest first.`);
  return prefix;
};

/** When the earliest open fact under a prefix is due (ms), for those scopes, or null when none is open. */
export function workshopNextDue(sql, prefix, { scopes } = {}) {
  fill(sql);
  const list = scopes ? [...scopes] : null;
  if (list && !list.length) return null;
  // reads-ok: the first row of the (kind, due) index
  return sql.exec(`SELECT MIN(due) AS at FROM workshop_current WHERE kind = ? AND due IS NOT NULL${list ? ` AND scope IN (${list.map(() => '?').join(', ')})` : ''}`, kindFor(prefix), ...(list ?? [])).toArray()[0]?.at ?? null;
}

/**
 * A token that changes whenever a fact under a prefix is written, replaced or forgotten: one read of the entities under
 * it, so a question answered from those facts can be kept until the token moves. → string
 */
export function workshopVersion(sql, prefix) {
  fill(sql);
  const [from, to] = rangeOf(prefix);
  // reads-ok: one prefix's entities in the current table, the token the caller keeps its answer on
  const { seq, held } = sql.exec('SELECT COALESCE(MAX(seq), 0) AS seq, COUNT(*) AS held FROM workshop_current WHERE entity >= ? AND entity < ?', from, to).toArray()[0];
  return `${seq}:${held}`;
}

/** When the earliest fact that may be let go can be (ms), or null when none ages out. */
export function workshopNextExpiry(sql) {
  for (const kind of TIMING_KINDS) fillSummary(sql, kind);
  // reads-ok: the first row of the expires index
  return sql.exec('SELECT expires AS at FROM workshop_current_timing WHERE expires IS NOT NULL ORDER BY expires LIMIT 1').toArray()[0]?.at ?? null;
}

/** Let go, every version, of at most `limit` facts that have aged out by `atMs`, oldest first. → how many. */
export function forgetExpiredWorkshopFacts(sql, atMs, limit) {
  for (const kind of TIMING_KINDS) fillSummary(sql, kind);
  const aged = sql.exec('SELECT entity FROM workshop_current_timing WHERE expires IS NOT NULL AND expires <= ? ORDER BY expires LIMIT ?', atMs, limit).toArray().map(row => row.entity);
  if (!aged.length) return 0;
  sql.exec('DELETE FROM workshop_facts WHERE entity IN (SELECT value FROM json_each(?))', JSON.stringify(aged));
  sql.exec('DELETE FROM workshop_current WHERE entity IN (SELECT value FROM json_each(?))', JSON.stringify(aged));
  sql.exec('DELETE FROM workshop_current_timing WHERE entity IN (SELECT value FROM json_each(?))', JSON.stringify(aged));
  return aged.length;
}

// One page of current values under a prefix, in entity order after `after` (an entity, '' for the first page): at most
// `limit` entities, read through the entity index so a page costs the same however many entities the prefix holds.
// Answers { rows: [{ entity, value }], next: the last entity, or null when none are left }.
export function workshopValuesPage(sql, prefix, { after = '', limit }) {
  refuseTasks(prefix);
  fill(sql);
  const [, to] = rangeOf(prefix);
  const from = after && after > prefix ? after : prefix;
  // The prefix itself sorts before every entity under it, so `entity > prefix` keeps the first one.
  const rows = sql.exec(`SELECT c.entity, f.value ${joined} WHERE c.entity > ? AND c.entity < ? ORDER BY c.entity LIMIT ?`, from, to, limit + 1).toArray();
  const page = rows.slice(0, limit);
  return { rows: page.map(row => ({ entity: row.entity, value: JSON.parse(row.value) })), next: rows.length > limit ? page.at(-1).entity : null };
}
