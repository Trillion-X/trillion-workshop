// src/activity.mjs
//
// PURPOSE
//   What each AI did on a person's account, kept so the person can see it (the AI activity screen) and so their AIs can
//   read what other AIs did (read_activity). Every tool call passes one seam (tools.mjs handleMcpMessage); a call whose
//   tool has a row in activity-marks.json becomes one row here: when, which AI app, what it did, the item it made or
//   touched, whether it worked and, when it did not, why.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no tool and no app: which calls leave a row, and how each reads, is DATA (activity-marks.json);
//      the app is whatever name the calling app registered when it connected, or what its requests say about it.
//   2. Only ids, short titles and the failure's own words are kept, never a call's full input or answer.
//   3. Keeping a row never changes a call's answer and never makes it wait (the Worker keeps it after replying).
//   4. Rows and their links are kept in generations (activity_g<n>, activity_links_g<n>), read through the views
//      activity and activity_links over the newest two. When the current generation holds `keep` rows a new one
//      starts and every older one is dropped whole, so between `keep` and twice `keep` rows stay readable and no row
//      is ever deleted one by one: a drop writes nothing, while trimming the oldest row on every write wrote as many
//      rows as keeping one did (2026-10-05: the delete and the insert were the top two writes on Sam's store).
//      A row's links live in its own generation and leave with it. `seq` is given by this file (one past the newest),
//      so no sequence row is written either.
//   5. How calls connect is DATA too: a mark's `uses` names where the ids a call used are found (files, handoffs, tools,
//      a decision), and `for` (top level, read in every call, plus a mark's own) names where what it was done for is
//      found. Each id is kept in activity_links beside the row it belongs to (role `made` for the row's item, `used`, `for`), so a trace reads
//      only the rows that touch the ids it follows, never the whole table.
//   6. What a plan keeps is DATA too: a mark's `kept_with` names the access a person must hold for the row to be kept at
//      all, and a `uses` or `for` place's `kept_with` the access they must hold for the id found there to be kept. The
//      row carries these needs (`kept_with: { row, ids }`) to the person's store, which alone knows what they hold;
//      keptActivityRow keeps what they may keep and drops the rest before anything is written (a free decision's goal,
//      move and run id are kept nowhere).
//   7. A call fails when it threw, or when what it answered says so by the DATA rule `failed` (a tool run whose task
//      ended failed); its own words are the reason either way. Each row's result is kept beside it (`ok`), so reading
//      only what failed reads only those rows. New managed rows carry the actor/card identity captured at dispatch.
//      Historical identity that was not captured stays unknown; a current card is shown separately.
//
// THE TRACE (traceActivity), read the same way by the screen and by an AI (trace_item)
//   { item, steps: [step] }, where a step is one kept row plus:
//     link     'made' (this call made or touched `about`), 'used' (this call used `about`) or 'for' (it was done for it)
//     about    the id this step is in the chain for
//     because  the seq of the step that led here (the one that used `about`), or null for the item's own steps
//     depth    how many hops from the item (0 = the item itself)
//   Steps come in order: the calls that made the item, then the calls that made what those used, and so on (at most
//   `depth` hops, each row and id once, so a loop ends), then the calls that used the item or were done for it.

import marksData from './activity-marks.json' with { type: 'json' };
import { EXECUTION_LIMITS, executionText } from './execution-context.mjs';

const TITLE_LENGTH = 200;
const REASON_LENGTH = 400;
const ID_LENGTH = EXECUTION_LIMITS.id_chars;
const IDS_KEPT = 20;
const TRACE_STEPS = 200;
const MARKS = new Map(marksData.marks.map(mark => [mark.tool, mark]));
/** When an answered call still did not work, and where its words for why are (activity-marks.json `failed`). */
const FAILED = marksData.failed ?? { when: [], reason: [] };
/** The name what the person does on their own Trillion page goes under (activity-marks.json `person_app`). */
export const PERSON_APP = marksData.person_app;

/** The value at `path` (keys and list positions) inside `value`, or undefined. */
function at(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** The first present text among `places` ({from: 'input'|'result', path}), cut to `length`. */
function firstText(places, sources, length) {
  for (const place of places ?? []) {
    const found = at(sources[place.from], place.path);
    if (typeof found === 'string' && found.trim()) return found.trim().slice(0, length);
    if (typeof found === 'number') return String(found);
  }
  return null;
}

// A tool may return a structured report as a JSON string in a field meant for a
// short title. Keep the useful human label while preventing the serialized
// report from becoming visible product copy.
function firstTitle(places, sources, length) {
  const value = firstText(places, sources, length);
  if (!value) return null;
  const text = value.trim();
  if (!/^[\[{]/.test(text)) return value;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['title', 'label', 'name', 'goal', 'summary', 'text', 'message']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].trim().slice(0, length);
      }
    }
  } catch { /* A leading brace can be ordinary text; keep the original below. */ }
  return value;
}

/** Whether any of `places` ({from, path, equals}) holds one of the values that say the call failed. */
const saysFailed = (places, sources) => (places ?? []).some(place => (place.equals ?? []).some(value => Object.is(at(sources[place.from], place.path), value)));

/** The members of a list, or the values of an object, at the end of an `each` place. */
const membersOf = value => (Array.isArray(value) ? value : value !== null && typeof value === 'object' ? Object.values(value) : []);

/**
 * Every id found at `places`, in order, each once, at most IDS_KEPT, as { id, kept_with } (the access its place names,
 * or null). A place is {from, path}: the value there is one id.
 * With `each: true` the path ends at a list (or an object) whose members are ids, or hold one at `path_in_each`.
 * `match` (a pattern) keeps only the values that look like an id of the kind meant, where the members are free values.
 */
function idsAt(places, sources) {
  const ids = new Map();
  for (const place of places ?? []) {
    const found = at(sources[place.from], place.path);
    const values = place.each ? membersOf(found).map(member => (place.path_in_each ? at(member, place.path_in_each) : member)) : [found];
    const pattern = place.match ? new RegExp(place.match) : null;
    for (const value of values) {
      const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
      if (!id || (pattern && !pattern.test(id)) || ids.has(id)) continue;
      executionText(id, 'activity reference', ID_LENGTH);
      ids.set(id, { id, kept_with: place.kept_with ?? null, basis: place.from === 'input' ? 'explicit_input' : 'tool_result' });
      if (ids.size >= IDS_KEPT) return [...ids.values()];
    }
  }
  return [...ids.values()];
}

/** The same declared places as the activity projection, with their exact boundary and field path retained.
 * These are named references, not a claim that submitted material was consumed or applied. Access needs travel
 * only to the store's admission boundary; neither a call payload nor those needs enters the execution record. */
export function activityExecutionCapture({ tool, input, result }, marks = MARKS, forPlaces = marksData.for) {
  const mark = marks.get(tool);
  if (!mark) return null;
  const sources = { input: input ?? {}, result: result ?? {} };
  const references = [], needs = [], seen = new Set();
  const add = (place, role, value, path, ordinal) => {
    const ref = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!ref || place.match && !new RegExp(place.match).test(ref)) return false;
    executionText(ref, 'execution reference', ID_LENGTH);
    const basis = place.from === 'input' ? 'explicit_input' : 'tool_result';
    const key = JSON.stringify([ref, role, basis, path]);
    if (!seen.has(key)) {
      if (references.length >= EXECUTION_LIMITS.links) throw new Error(`Execution references exceed the ${EXECUTION_LIMITS.links} reference capture limit; they were not truncated.`);
      seen.add(key);
      references.push({ ref, role, basis, path, ...(ordinal === undefined ? {} : { ordinal }) });
    }
    if (place.kept_with) needs.push({ id: ref, access: place.kept_with });
    return true;
  };
  for (const place of mark.item ?? []) {
    if (add(place, 'item', at(sources[place.from], place.path), place.path)) break;
  }
  for (const [role, places] of [['uses', mark.uses ?? []], ['for', [...(forPlaces ?? []), ...(mark.for ?? [])]]]) {
    for (const place of places) {
      const found = at(sources[place.from], place.path);
      if (!place.each) { add(place, role, found, place.path); continue; }
      const entries = Array.isArray(found) ? found.map((value, index) => [index, value])
        : found && typeof found === 'object' ? Object.entries(found) : [];
      for (const [ordinal, [key, member]] of entries.entries()) {
        add(place, role, place.path_in_each ? at(member, place.path_in_each) : member,
          [...place.path, key, ...(place.path_in_each ?? [])], ordinal);
      }
    }
  }
  return { references, ...(mark.kept_with || needs.length ? { kept_with: { row: mark.kept_with ?? null, ids: needs } } : {}) };
}

/**
 * The row one tool call leaves, or null when its tool leaves none or the call made or touched nothing (a take_work
 * that found nothing waiting). A failed call always leaves a row, with the failure's own words.
 */
export function activityRow({ tool, input, result, error, app, userAgent, clientVersion, execution, at: when }, marks = MARKS, agentPlaces = marksData.agent, forPlaces = marksData.for, failed = FAILED) {
  const mark = marks.get(tool);
  if (!mark) return null;
  const sources = { input: input ?? {}, result: result ?? {} };
  const item = firstText(mark.item, sources, Infinity);
  executionText(item, 'activity item', ID_LENGTH);
  const answeredFailed = !error && saysFailed([...(failed.when ?? []), ...(mark.failed ?? [])], sources);
  if (!item && !error && !answeredFailed) return null;
  const agentName = firstText(mark.agent_name, sources, 120);
  const model = firstText(mark.model, sources, 120);
  const uses = idsAt(mark.uses, sources).filter(({ id }) => id !== item);
  const forIds = idsAt([...(forPlaces ?? []), ...(mark.for ?? [])], sources).filter(({ id }) => id !== item);
  const needs = [...uses, ...forIds].filter(({ kept_with: access }) => access).map(({ id, kept_with: access }) => ({ id, access }));
  return {
    at: when,
    ...(execution ? { execution_ref: execution.execution_ref, identity_snapshot: execution.actor, capture_kind: execution.capture_kind, origin: execution.origin } : {}),
    app: typeof app === 'string' && app.trim() ? app.trim().slice(0, 120) : null,
    ...(typeof userAgent === 'string' && userAgent.trim() ? { user_agent: userAgent.trim().slice(0, 200) } : {}),
    ...(typeof clientVersion === 'string' && clientVersion.trim() ? { client_version: clientVersion.trim().slice(0, 80) } : {}),
    tool,
    label: mark.label,
    item,
    title: firstTitle(mark.title, sources, TITLE_LENGTH),
    agent: firstText(agentPlaces, sources, 120),
    ...(agentName ? { agent_name: agentName } : {}),
    ...(model ? { model } : {}),
    opens: mark.opens ?? null,
    ...(mark.facts ? { facts: Object.fromEntries(Object.entries(mark.facts).map(([name, places]) => [name, firstText(places, sources, TITLE_LENGTH)]).filter(([, value]) => value !== null)) } : {}),
    uses: uses.map(({ id }) => id),
    for: forIds.map(({ id }) => id),
    ...(forIds.length ? { for_basis: Object.fromEntries(forIds.map(({ id, basis }) => [id, basis])) } : {}),
    ok: !error && !answeredFailed,
    reason: error ? String(error).slice(0, REASON_LENGTH) : answeredFailed ? firstText(failed.reason, sources, REASON_LENGTH) : null,
    ...(mark.kept_with || needs.length ? { kept_with: { row: mark.kept_with ?? null, ids: needs } } : {}),
  };
}

/**
 * The row a call whose tool has no mark leaves when it has a durable execution receipt or an explicitly recorded
 * association. What it did is the tool's description, cut at its first clause. Sharing an app, sign-in or agent
 * with a held job does not establish that this call served that job.
 */
export function unmarkedActivityRow({ tool, description, reads, input, error, app, userAgent, clientVersion, execution, at: when }, marks = MARKS, agentPlaces = marksData.agent) {
  if (marks.has(tool) || typeof tool !== 'string' || !tool) return null;
  const said = typeof description === 'string' ? description.trim().split(/\s\(|(?<=[a-z0-9)])[.:;](?:\s|$)|,\s/)[0].trim() : '';
  return {
    at: when,
    ...(execution ? { execution_ref: execution.execution_ref, identity_snapshot: execution.actor, capture_kind: execution.capture_kind, origin: execution.origin } : {}),
    app: typeof app === 'string' && app.trim() ? app.trim().slice(0, 120) : null,
    ...(typeof userAgent === 'string' && userAgent.trim() ? { user_agent: userAgent.trim().slice(0, 200) } : {}),
    ...(typeof clientVersion === 'string' && clientVersion.trim() ? { client_version: clientVersion.trim().slice(0, 80) } : {}),
    tool,
    label: (said || tool).slice(0, TITLE_LENGTH),
    item: null,
    title: null,
    agent: firstText(agentPlaces, { input: input ?? {}, result: {} }, 120),
    opens: null,
    uses: [],
    for: [],
    ok: !error,
    reason: error ? String(error).slice(0, REASON_LENGTH) : null,
    held_only: true,
    // Whether the tool only reads (its own readOnlyHint), so a step can say it read rather than changed something.
    ...(typeof reads === 'boolean' ? { reads } : {}),
  };
}

/**
 * The row as the activity record takes it from a caller: null when it is a step with no receipt and no work it was
 * done for (unmarkedActivityRow's held_only rows need one of them), else the row without that flag. Both writers of
 * the record (PersonStore recordActivity and the native activity:keep) read rows through this.
 */
export function recordableActivityRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (row.held_only && !row.execution_ref && !row.for?.length) return null;
  const { held_only: _held, ...shown } = row;
  return shown;
}

/** The rows one request hands the activity record, each read through recordableActivityRow; at most `kept_at_once`. */
export function recordableActivityRows(rows, atOnce = marksData.kept_at_once) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('Send the activity rows to keep as a list.'), { status: 400 });
  if (rows.length > atOnce) throw Object.assign(new Error(`At most ${atOnce} activity rows can be kept at once.`), { status: 400 });
  return rows.map(recordableActivityRow).filter(Boolean);
}

/**
 * The row as a person holding `capabilities` (their access, src/payment.mjs accessFrom) keeps it: null when its mark
 * needs an access they do not hold, else the row without its needs and without any id whose place needs such an access.
 */
export function keptActivityRow(row, capabilities) {
  if (!row) return null;
  const { kept_with: needs, ...kept } = row;
  if (!needs) return kept;
  if (needs.row && !capabilities.includes(needs.row)) return null;
  const dropped = new Set(needs.ids.filter(({ access }) => !capabilities.includes(access)).map(({ id }) => id));
  return dropped.size ? { ...kept, uses: kept.uses.filter(id => !dropped.has(id)), for: kept.for.filter(id => !dropped.has(id)),
    ...(kept.for_basis ? { for_basis: Object.fromEntries(Object.entries(kept.for_basis).filter(([id]) => !dropped.has(id))) } : {}) } : kept;
}

/** A descriptor records where a work reference came from. Older rows captured no basis; a current card or held
 *  job cannot establish one retrospectively. This reads the row without rewriting its original history. */
export function activityAssociationBasis(row, id) {
  const basis = row?.for_basis && Object.hasOwn(row.for_basis, id) ? row.for_basis[id] : null;
  return ['explicit_input', 'tool_result'].includes(basis) ? basis : 'legacy_unknown';
}

const READY = new WeakSet();
// Per store: the current generation, how many rows it holds and the newest seq, read once per store lifetime.
const STATE = new WeakMap();
const ROW_COLUMNS = 'seq, at, app, row, ok';
const LINK_COLUMNS = 'seq, id, role';
// Per store: how many times its activity was cleared (activityResets).
const RESETS = new WeakMap();

/** Which generations the views read now: changes only when a full generation is dropped, so a count kept over
 * activity rows (src/record-scope.mjs scope_value_counts) knows its rows may have gone. */
export const visibleActivity = sql => { activityTable(sql); return STATE.get(sql).visible.join(','); };

/** A Durable Object may clear its SQLite storage while keeping the same SQL handle. */
export const forgetActivityTable = sql => { READY.delete(sql); STATE.delete(sql); RESETS.set(sql, activityResets(sql) + 1); };
/** How many times this SQL handle's activity was cleared: rows kept after a reset start their seq again. */
export const activityResets = sql => RESETS.get(sql) ?? 0;

// The store's activity tables and views, read in one pass: every read of sqlite_master reads each row it holds (519 in the
// founder's own records, 2026-10-21), and the four reads opening activity took, with a newest seq read through the view,
// made the first write after a store opened read about 10,000 rows and stopped at its bound.
const activitySchema = sql => [...sql.exec("SELECT type, name, sql FROM sqlite_master WHERE name IN ('activity', 'activity_links') OR name GLOB 'activity_g[0-9]*' OR name GLOB 'activity_counts_g[0-9]*'")];
const numbered = (schema, prefix) => schema.filter(row => row.type === 'table' && row.name.startsWith(prefix))
  .map(row => Number(row.name.slice(prefix.length))).filter(Number.isInteger).sort((a, b) => a - b);
const generationsOf = (sql, schema = activitySchema(sql)) => numbered(schema, 'activity_g');

// A generation made now also keeps, for each id its calls link, how many calls link it (activity_counts_g<n>), written
// as the calls are kept, so a count for a decision that thousands of calls were done for is one row, not thousands of
// links. A generation made before this has no such table and is counted from its links, as it always was.
function createGeneration(sql, n, { counted = true } = {}) {
  if (counted) sql.exec(`CREATE TABLE IF NOT EXISTS activity_counts_g${n} (id TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS activity_g${n} (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, app TEXT, row TEXT NOT NULL, ok INTEGER)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS activity_g${n}_by_ok ON activity_g${n} (ok, seq)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS activity_links_g${n} (seq INTEGER NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS activity_links_g${n}_by_id ON activity_links_g${n} (id, role)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS activity_links_g${n}_by_seq ON activity_links_g${n} (seq)`);
}

// The views over the newest two generations, made again only when they name other generations than they do now.
function viewOver(sql, generations, schema = activitySchema(sql)) {
  const wanted = {
    activity: `CREATE VIEW activity AS ${generations.map(n => `SELECT ${ROW_COLUMNS} FROM activity_g${n}`).join(' UNION ALL ')}`,
    activity_links: `CREATE VIEW activity_links AS ${generations.map(n => `SELECT ${LINK_COLUMNS} FROM activity_links_g${n}`).join(' UNION ALL ')}`,
  };
  const now = new Map(schema.filter(row => row.type === 'view').map(row => [row.name, row.sql]));
  for (const [name, statement] of Object.entries(wanted)) {
    if (now.get(name) === statement) continue;
    sql.exec(`DROP VIEW IF EXISTS ${name}`);
    sql.exec(statement);
  }
}

/** Creates the tables (once per store). Rows kept in one table before generations become the first generation. */
export function activityTable(sql) {
  if (READY.has(sql)) return;
  let schema = activitySchema(sql);
  const kept = schema.find(row => row.name === 'activity');
  if (kept?.type === 'table') {
    // A table made before each row's result was kept beside it gets the column, filled from the rows it holds.
    if (!/\bok INTEGER\b/.test(kept.sql ?? '')) {
      sql.exec('ALTER TABLE activity ADD COLUMN ok INTEGER');
      sql.exec("UPDATE activity SET ok = json_extract(row, '$.ok')");
    }
    const linked = schema.some(row => row.type === 'table' && row.name === 'activity_links');
    sql.exec('CREATE TABLE IF NOT EXISTS activity_links (seq INTEGER NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL)');
    if (!linked) sql.exec("INSERT INTO activity_links (seq, id, role) SELECT seq, json_extract(row, '$.item'), 'made' FROM activity WHERE json_extract(row, '$.item') IS NOT NULL");
    const first = (generationsOf(sql, schema).at(-1) ?? 0) + 1;
    sql.exec(`ALTER TABLE activity RENAME TO activity_g${first}`);
    sql.exec(`ALTER TABLE activity_links RENAME TO activity_links_g${first}`);
    createGeneration(sql, first, { counted: false });
    schema = activitySchema(sql);
  }
  let generations = generationsOf(sql, schema);
  const counted = new Set(numbered(schema, 'activity_counts_g'));
  if (!generations.length) { createGeneration(sql, 1); generations = [1]; counted.add(1); }
  viewOver(sql, generations.slice(-2), schema);
  const current = generations.at(-1);
  // Rows are only added with the next seq and a generation is dropped whole, so the newest holds the seqs from its
  // first to its last: the two ends of the key give its size without reading its rows, and its last is the newest seq
  // (the one before it holds the newest while it is still empty). Never MAX through the view: it reads every row.
  // (One query each: SQLite finds only one end of a key per query without reading the rows between.)
  const end = (n, order) => [...sql.exec(`SELECT seq FROM activity_g${n} ORDER BY seq ${order} LIMIT 1`)][0]?.seq ?? null;
  const first = end(current, 'ASC'), last = end(current, 'DESC');
  const before = generations.at(-2);
  STATE.set(sql, {
    current,
    visible: generations.slice(-2),
    counted,
    count: last === null ? 0 : Number(last) - Number(first) + 1,
    seq: Number(last ?? (before === undefined ? null : end(before, 'DESC')) ?? 0),
  });
  READY.add(sql);
}

// A new generation once the current one is full; the views move to it and every generation older than the one it
// follows is dropped whole.
function nextGeneration(sql, state) {
  const next = state.current + 1;
  createGeneration(sql, next);
  viewOver(sql, [state.current, next]);
  for (const old of generationsOf(sql).filter(n => n < state.current)) {
    sql.exec(`DROP TABLE IF EXISTS activity_links_g${old}`);
    sql.exec(`DROP TABLE IF EXISTS activity_counts_g${old}`);
    sql.exec(`DROP TABLE IF EXISTS activity_g${old}`);
    state.counted.delete(old);
  }
  state.counted.add(next);
  state.current = next;
  state.visible = [next - 1, next];
  state.count = 0;
}

/** Keeps one row with its links in the current generation (see invariant 4). */
export function keepActivity(sql, row, keep = marksData.keep) {
  activityTable(sql);
  const state = STATE.get(sql);
  if (state.count >= keep) nextGeneration(sql, state);
  const seq = state.seq + 1;
  sql.exec(`INSERT INTO activity_g${state.current} (seq, at, app, row, ok) VALUES (?, ?, ?, ?, ?)`, seq, row.at, row.app, JSON.stringify(row), row.ok === false ? 0 : 1);
  state.seq = seq;
  state.count += 1;
  const links = [[row.item, 'made'], [row.execution_ref, 'used'], ...(row.uses ?? []).map(id => [id, 'used']), ...(row.for ?? []).map(id => [id, 'for'])];
  for (const [id, role] of links) if (typeof id === 'string' && id) sql.exec(`INSERT INTO activity_links_g${state.current} (seq, id, role) VALUES (?, ?, ?)`, seq, id, role);
  // One more call for each id it names (once, however many roles it names it in), kept beside the links.
  if (state.counted.has(state.current)) for (const id of new Set(links.map(([id]) => id).filter(id => typeof id === 'string' && id))) {
    sql.exec(`INSERT INTO activity_counts_g${state.current} (id, n) VALUES (?, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1`, id);
  }
  return {generation:state.current,seq};
}

/**
 * Newest first, `limit` at a time; `before` is the `seq` of the last row already read. `app` narrows to one app, `for`
 * to the calls done for one id or any of a list of ids (a decision, a pursuit and its decisions), `failed` to the calls
 * that did not work.
 */
export function readActivity(sql, { before = null, limit = 200, app = null, for: forId = null, failed = false } = {}) {
  activityTable(sql);
  const size = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const clauses = [];
  const params = [];
  const older = before === null || before === undefined || before === '' ? null : Number(before);
  if (Number.isInteger(older)) { clauses.push('seq < ?'); params.push(older); }
  if (typeof app === 'string' && app) { clauses.push('app = ?'); params.push(app); }
  if (failed === true || failed === 'true' || failed === '1') clauses.push('ok = 0');
  // `for` is one id, or a list of them: the rows done for any of them (a goal and the decisions made for it).
  const forIds = (Array.isArray(forId) ? forId : [forId]).filter(id => typeof id === 'string' && id);
  if (forIds.length) { clauses.push(`seq IN (SELECT seq FROM activity_links WHERE role = 'for' AND id IN (${forIds.map(() => '?').join(', ')}))`); params.push(...forIds); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = [...sql.exec(`SELECT seq, row FROM activity ${where} ORDER BY seq DESC LIMIT ?`, ...params, size + 1)];
  const items = rows.slice(0, size).map(({ seq, row }) => ({ seq, ...JSON.parse(row) }));
  return { items, next_before: rows.length > size ? items[items.length - 1].seq : null, coverage: { source: 'bounded_activity_feed', generation_rows: marksData.keep, generations: 2, ids_per_role: IDS_KEPT, durable_sources: 'execution_records' } };
}

/** One exact kept call. A saved owner verification can distinguish a rolled-away row from a missing/forged id. */
export function readActivityReference(sql, seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) return { row: null, expired: false };
  activityTable(sql);
  const found = [...sql.exec('SELECT seq, row FROM activity WHERE seq = ?', seq)][0];
  if (found) return { row: { seq: found.seq, ...JSON.parse(found.row) }, expired: false };
  const earliest = [...sql.exec('SELECT MIN(seq) AS seq FROM activity')][0]?.seq;
  return { row: null, expired: Number.isSafeInteger(earliest) && earliest > seq };
}

/** Captured identity is immutable. A current card is supplementary context for an older row, never proof of the
 *  older action's chat or model; a runtime user-agent is not an originating AI identity. */
export function namedActivityRows(rows, cards = []) {
  const byId = new Map(cards.map(card => [card.agent_id, card]));
  return rows.map(original => {
    const row = original.for?.length ? { ...original, for_basis: Object.fromEntries(original.for.map(id => [id, activityAssociationBasis(original, id)])) } : original;
    const card = row.agent ? byId.get(row.agent) : null;
    const snapshot = row.identity_snapshot;
    if (snapshot) {
      const selected = snapshot.basis === 'registered_agent_snapshot' && snapshot.selection_basis === 'caller_named_reader_bound_card';
      return { ...row, agent_name: selected ? snapshot.agent_name ?? null : null, chat: selected ? snapshot.conversation_id ?? null : null,
        model: selected ? snapshot.model ?? null : null, identity_basis: snapshot.basis ?? 'unknown' };
    }
    const name = card?.name && card.name !== 'unknown' ? card.name : null;
    const model = card?.model && card.model !== 'unknown' ? card.model : null;
    const harness = card?.harness && card.harness !== 'unknown' ? card.harness : null;
    const rawApp = typeof row.app === 'string' ? row.app.trim() : '';
    const transport = /^(?:node(?:\.js)?|undici|curl|python(?:-requests)?|go-http-client|java|okhttp|mozilla\/|axios\/|fetch\/)/i.test(rawApp);
    return { ...row, app: transport ? null : rawApp || null,
      identity_basis: 'historical_source_not_captured',
      current_agent: card ? { agent_id: card.agent_id, name, model, conversation_id: card.source_id ?? null, basis: 'current_card_only' } : null,
      user_agent: row.user_agent ?? (transport ? rawApp : null),
      agent_name: row.agent_name ?? null,
      chat: row.chat ?? null,
      model: row.model && row.model !== 'unknown' ? row.model : null };
  });
}

/** Read raw link candidates before filtering, then only their exact row keys. The existing (id, role) index has
 * rowid as its last key, so a hot target never sorts or materializes its full history to answer a bounded trace. */
function linkedRows(sql, id, roles, limit, newest = false) {
  const linked = [];
  const generations = [...STATE.get(sql).visible];
  if (newest) generations.reverse();
  for (const generation of generations) {
    for (const role of roles) {
      const remaining = limit + 1 - linked.length;
      if (remaining <= 0) break;
      const page = sql.exec(`SELECT seq, role FROM activity_links_g${generation} INDEXED BY activity_links_g${generation}_by_id WHERE id = ? AND role = ? ORDER BY rowid ${newest ? 'DESC' : 'ASC'} LIMIT ?`, id, role, remaining);
      for (const row of page) linked.push({ ...row, generation });
    }
    if (linked.length > limit) break;
  }
  const selected = linked.slice(0, limit), rows = new Map();
  for (const generation of generations) {
    const ids = [...new Set(selected.filter(row => row.generation === generation).map(row => row.seq))];
    if (!ids.length) continue;
    for (const found of sql.exec(`SELECT seq, row FROM activity_g${generation} WHERE seq IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))) rows.set(found.seq, found.row);
  }
  return { rows: selected.filter(link => rows.has(link.seq)).sort((a, b) => newest ? b.seq - a.seq : a.seq - b.seq)
    .map(link => ({ seq: link.seq, role: link.role, row: rows.get(link.seq) })), examined: linked.length, more: linked.length > limit };
}

/**
 * How `item` came about and what came of it (the shape is in the header): the calls that made it, then, hop by hop up
 * to `depth`, the calls that made what they used, then the calls that used it or were done for it.
 */
export function traceActivity(sql, { item, depth = 4 } = {}) {
  activityTable(sql);
  const id = typeof item === 'string' ? item.trim() : '';
  if (!id) return { item: null, steps: [] };
  const hops = Math.min(Math.max(Number.isInteger(Number(depth)) ? Number(depth) : 4, 0), 8);
  const steps = [];
  const seenRows = new Set();
  const seenIds = new Set([id]);
  let examined = 0, queries = 0, limited = false;
  const read = (about, roles, newest = false) => {
    if (examined >= TRACE_STEPS || queries >= TRACE_STEPS || steps.length >= TRACE_STEPS) { limited = true; return []; }
    const page = linkedRows(sql, about, roles, TRACE_STEPS - examined, newest);
    queries += 1;
    examined += page.examined;
    limited ||= page.more;
    return page.rows;
  };
  let wave = [{ about: id, because: null }];
  for (let level = 0; level <= hops && wave.length && steps.length < TRACE_STEPS; level += 1) {
    const next = [];
    for (const { about, because } of wave) {
      if (examined >= TRACE_STEPS || queries >= TRACE_STEPS || steps.length >= TRACE_STEPS) { limited = true; break; }
      for (const { seq, row } of read(about, ['made'])) {
        if (seenRows.has(seq) || steps.length >= TRACE_STEPS) continue;
        seenRows.add(seq);
        const kept = JSON.parse(row);
        steps.push({ seq, ...kept, link: 'made', about, because, depth: level });
        for (const used of kept.uses ?? []) if (!seenIds.has(used)) {
          if (seenIds.size >= TRACE_STEPS) { limited = true; break; }
          seenIds.add(used); next.push({ about: used, because: seq });
        }
      }
    }
    wave = next;
  }
  const after = read(id, ['used', 'for'], true);
  for (const { seq, role, row } of after) {
    if (seenRows.has(seq) || steps.length >= TRACE_STEPS) continue;
    seenRows.add(seq);
    steps.push({ seq, ...JSON.parse(row), link: role, about: id, because: null, depth: 1 });
  }
  return { item: id, steps, coverage: { source: 'bounded_activity_feed', step_limit: TRACE_STEPS, depth_limit: hops,
    reference_limit: TRACE_STEPS, reference_queries: queries, candidates_examined: examined,
    limit_reached: limited || steps.length >= TRACE_STEPS || wave.length > 0, historical_origin: 'captured_receipts_only' } };
}

/** Every kept row that made, used or was done for any of `ids`, oldest first, each once: the steps of one piece of work. */
export function activityFor(sql, ids, limit = TRACE_STEPS) {
  activityTable(sql);
  const wanted = [...new Set((ids ?? []).filter(id => typeof id === 'string' && id))];
  if (!wanted.length) return [];
  return [...sql.exec(`SELECT seq, row FROM activity WHERE seq IN (SELECT seq FROM activity_links WHERE id IN (${wanted.map(() => '?').join(', ')})) ORDER BY seq DESC LIMIT ?`, ...wanted, limit)]
    .reverse().map(({ seq, row }) => ({ seq, ...JSON.parse(row) }));
}

/** How many kept calls name any of `ids` (a job, its decision, the parts it passed on): one indexed count, so a list of
 *  jobs can say how far each has got without reading a single row. */
export function activityCount(sql, ids) {
  activityTable(sql);
  const wanted = [...new Set((ids ?? []).filter(id => typeof id === 'string' && id))];
  if (!wanted.length) return 0;
  return sql.exec('SELECT COUNT(DISTINCT seq) AS n FROM activity_links WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(wanted)).toArray()[0].n;
}

// Per store: the calls already read for each id activityCounts was asked about, and the newest seq they cover, so a
// list polled again reads only the links kept since. Kept for the ids of the latest call only.
const COUNTED = new WeakMap();
// An id that more calls than this link (one decision many jobs were done for) is counted from the counts kept for it
// (activity_counts_g<n>), never read link by link.
const HOT_LINKS = 64;

/** Count distinct kept calls for many pieces of work in one indexed read. Each group names its own id and the
 *  related ids whose calls belong in the same progress line. */
export function activityCounts(sql, groups) {
  const relatedByGroup = new Map();
  for (const { id, related } of groups ?? []) {
    if (typeof id !== 'string' || !id) continue;
    const ids = relatedByGroup.get(id) ?? new Set();
    for (const value of related ?? []) if (typeof value === 'string' && value) ids.add(value);
    relatedByGroup.set(id, ids);
  }
  const wanted = [...new Set([...relatedByGroup.values()].flatMap(ids => [...ids]))];
  if (!wanted.length) return new Map();
  activityTable(sql);
  const state = STATE.get(sql);
  const at = { resets: activityResets(sql), visible: state.visible.join(',') };
  const counted = state.visible.filter(n => state.counted.has(n));
  const uncounted = state.visible.filter(n => !state.counted.has(n));
  let kept = COUNTED.get(sql);
  if (!kept || kept.resets !== at.resets || kept.visible !== at.visible) kept = { ...at, seq: state.seq, byId: new Map(), hot: new Map(), inHot: new Map(), unions: new Map() };
  const sequencesById = new Map(wanted.filter(id => kept.byId.has(id)).map(id => [id, kept.byId.get(id)]));
  const hot = new Map(wanted.filter(id => kept.hot.has(id)).map(id => [id, kept.hot.get(id)]));
  const add = (id, seq) => { if (!sequencesById.has(id)) sequencesById.set(id, new Set()); sequencesById.get(id).add(seq); };
  // How many calls the counted generations hold for each of these ids, one statement.
  const countsOf = ids => {
    const found = new Map();
    if (!ids.length || !counted.length) return found;
    const query = counted.map(n => `SELECT id, n FROM activity_counts_g${n} WHERE id IN (SELECT value FROM json_each(?))`).join(' UNION ALL ');
    for (const { id, n } of sql.exec(query, ...counted.map(() => JSON.stringify(ids)))) found.set(id, (found.get(id) ?? 0) + Number(n));
    return found;
  };
  // Links of these ids, from the generations that are counted (only ids that are not hot) and the ones that are not (all ids).
  const linksOf = (ids, build) => {
    const plain = ids.filter(id => !hot.has(id));
    const parts = state.visible.map(n => ({ n, ids: state.counted.has(n) ? plain : ids })).filter(part => part.ids.length);
    if (!parts.length) return [];
    return [...sql.exec(parts.map(part => build(part.n)).join(' UNION ALL '), ...parts.flatMap(part => build.params(part.ids)))];
  };
  // Ids read before: only the links kept after the newest seq they cover, by the seq index.
  const known = wanted.filter(id => sequencesById.has(id));
  if (known.length && state.seq > kept.seq) {
    for (const [id, count] of countsOf([...hot.keys()])) hot.set(id, count);
    const since = Object.assign(n => `SELECT a.id, a.seq FROM activity_links_g${n} AS a INDEXED BY activity_links_g${n}_by_seq
      WHERE a.seq > ? AND a.id IN (SELECT value FROM json_each(?))`, { params: ids => [kept.seq, JSON.stringify(ids)] });
    for (const { id, seq } of linksOf(known, since)) add(id, seq);
  }
  // Ids not read before: every link they have, except those of an id so many calls name that its count is kept
  // instead. A related id can name many work rows (one decision's activity, for example). Joining group/id pairs to
  // links multiplies all of those rows once per work item before COUNT(DISTINCT seq). Seek each id only once instead.
  // One statement answers both: the count of each such id, and the links of every other.
  const readFresh = ids => {
    const counting = counted.length > 0;
    const totals = counted.map(n => `SELECT id, n FROM activity_counts_g${n} WHERE id IN (SELECT id FROM wanted)`).join(' UNION ALL ');
    const parts = state.visible.map(n => `SELECT a.id AS id, a.seq AS seq, 0 AS hot FROM ${counting && state.counted.has(n) ? 'plain' : 'wanted'} AS s
      CROSS JOIN activity_links_g${n} AS a INDEXED BY activity_links_g${n}_by_id WHERE a.id = s.id`);
    if (counting) parts.unshift(`SELECT t.id AS id, t.n AS seq, 1 AS hot FROM totals AS t WHERE t.n > ${HOT_LINKS}`);
    const counts = counting ? `, totals AS (SELECT id, SUM(n) AS n FROM (${totals}) GROUP BY id),
      plain AS (SELECT w.id AS id FROM wanted AS w LEFT JOIN totals AS t ON t.id = w.id WHERE COALESCE(t.n, 0) <= ${HOT_LINKS})` : '';
    for (const { id, seq, hot: counted_ } of sql.exec(`WITH wanted AS (SELECT value AS id FROM json_each(?))${counts} ${parts.join(' UNION ALL ')}`, JSON.stringify(ids))) {
      if (counted_) hot.set(id, Number(seq)); else add(id, seq);
    }
    for (const id of ids) if (!sequencesById.has(id)) sequencesById.set(id, new Set());
  };
  const fresh = wanted.filter(id => !sequencesById.has(id));
  if (fresh.length) readFresh(fresh);
  // An id first read while small can become hot between polls. Keep only its links from uncounted generations
  // once its counted total grows; otherwise a warm cache would keep expanding the history forever.
  const growing = known.filter(id => !hot.has(id) && sequencesById.get(id)?.size > HOT_LINKS);
  const promoted = [...countsOf(growing)].filter(([, n]) => n > HOT_LINKS);
  if (promoted.length) {
    for (const [id, n] of promoted) { hot.set(id, n); sequencesById.set(id, new Set()); }
    if (uncounted.length) {
      const query = uncounted.map(n => `SELECT id, seq FROM activity_links_g${n} INDEXED BY activity_links_g${n}_by_id
        WHERE id IN (SELECT value FROM json_each(?))`).join(' UNION ALL ');
      for (const { id, seq } of sql.exec(query, ...uncounted.map(() => JSON.stringify(promoted.map(([id]) => id))))) add(id, seq);
    }
  }
  // Several hot ids need their distinct union, not the sum (or only the first one's total). Cache that scalar
  // for the current hot-id set, then advance through new sequence numbers only. Never flatten every selected
  // id because one group combines two hot decisions. The same hot set can be shared by many work rows.
  const unions = new Map(), unionOfGroup = new Map();
  for (const [group, related] of relatedByGroup) {
    const ids = [...related].filter(id => hot.has(id)).sort();
    if (ids.length < 2) continue;
    const key = JSON.stringify(ids);
    unionOfGroup.set(group, key);
    if (unions.has(key)) continue;
    const prior = kept.unions?.get(key);
    // Query failure must leave the retained scalar and watermark together; publish only after every probe works.
    const memo = prior ? { ...prior, yes: new Set(prior.yes), no: new Set(prior.no) }
      : { ids, n: 0, seq: 0, yes: new Set(), no: new Set() };
    if (!prior || state.seq > memo.seq) {
      const parts = state.visible.map(n => `SELECT a.seq FROM activity_links_g${n} AS a
        INDEXED BY activity_links_g${n}_${prior ? 'by_seq' : 'by_id'}
        WHERE ${prior ? 'a.seq > ? AND ' : ''}a.id IN (SELECT value FROM json_each(?))`);
      const params = state.visible.flatMap(() => prior ? [memo.seq, key] : [key]);
      const row = sql.exec(`SELECT COUNT(DISTINCT seq) AS n FROM (${parts.join(' UNION ALL ')})`, ...params).toArray()[0];
      memo.n += Number(row.n);
      memo.seq = state.seq;
    }
    unions.set(key, memo);
  }
  for (const [key, memo] of unions) {
    const ask = new Set();
    for (const [group, related] of relatedByGroup) {
      if (unionOfGroup.get(group) !== key) continue;
      for (const id of related) if (!hot.has(id)) for (const seq of sequencesById.get(id) ?? []) {
        if (!memo.yes.has(seq) && !memo.no.has(seq)) ask.add(seq);
      }
    }
    if (!ask.size) continue;
    const query = state.visible.map(n => `SELECT a.seq FROM activity_links_g${n} AS a INDEXED BY activity_links_g${n}_by_seq
      WHERE a.seq IN (SELECT value FROM json_each(?)) AND a.id IN (SELECT value FROM json_each(?))`).join(' UNION ALL ');
    for (const { seq } of sql.exec(query, ...state.visible.flatMap(() => [JSON.stringify([...ask]), key]))) memo.yes.add(seq);
    for (const seq of ask) if (!memo.yes.has(seq)) memo.no.add(seq);
  }
  // Which of the calls other ids hold the counted generations also link to a hot id, asked once per hot id for the
  // calls not asked about before.
  const inHot = new Map([...hot.keys()].map(id => [id, kept.inHot.get(id) ?? { yes: new Set(), no: new Set() }]));
  for (const [hotId, memo] of inHot) {
    const ask = new Set();
    for (const [group, ids] of relatedByGroup) {
      if (unionOfGroup.has(group)) continue;
      if (!ids.has(hotId)) continue;
      const mine = sequencesById.get(hotId) ?? new Set();
      for (const id of ids) if (!hot.has(id)) for (const seq of sequencesById.get(id) ?? []) if (!mine.has(seq) && !memo.yes.has(seq) && !memo.no.has(seq)) ask.add(seq);
    }
    if (!ask.size || !counted.length) continue;
    const query = counted.map(n => `SELECT a.seq FROM activity_links_g${n} AS a INDEXED BY activity_links_g${n}_by_seq
      WHERE a.seq IN (SELECT value FROM json_each(?)) AND a.id = ?`).join(' UNION ALL ');
    for (const { seq } of sql.exec(query, ...counted.flatMap(() => [JSON.stringify([...ask]), hotId]))) memo.yes.add(seq);
    for (const seq of ask) if (!memo.yes.has(seq)) memo.no.add(seq);
  }
  COUNTED.set(sql, { ...at, seq: state.seq, byId: sequencesById, hot, inHot, unions });
  const counts = new Map();
  for (const [group, related] of relatedByGroup) {
    const hotId = [...related].find(id => hot.has(id));
    const sets = [...related].filter(id => !hot.has(id)).map(id => sequencesById.get(id)).filter(set => set?.size).sort((a, b) => b.size - a.size);
    if (unionOfGroup.has(group)) {
      const memo = unions.get(unionOfGroup.get(group));
      const others = new Set(sets.flatMap(set => [...set]));
      counts.set(group, memo.n + [...others].filter(seq => !memo.yes.has(seq)).length);
      continue;
    }
    if (hotId !== undefined) {
      // The hot id's calls are its count (those in counted generations) and its own links (the rest); the other ids add
      // the calls of theirs that it does not link.
      const mine = sequencesById.get(hotId) ?? new Set();
      const memo = inHot.get(hotId);
      const others = new Set(sets.flatMap(set => [...set]));
      let count = hot.get(hotId) + mine.size;
      for (const seq of others) if (!mine.has(seq) && !memo.yes.has(seq)) count += 1;
      counts.set(group, count);
      continue;
    }
    if (!sets.length) continue;
    // Reuse the largest set as a read-only base. A hot decision shared by hundreds of jobs is counted once;
    // only the other ids' sequence numbers need membership checks for each job.
    const base = sets[0];
    let count = base.size;
    const added = new Set();
    for (const extra of sets.slice(1)) for (const seq of extra) {
      if (!base.has(seq) && !added.has(seq)) { added.add(seq); count += 1; }
    }
    counts.set(group, count);
  }
  return counts;
}

/**
 * Each app's mark from its own sign-in registration: its logo when it gave one at a secure address, else its web
 * address (its own site, or where it asked to be sent back), which `logoOf` turns into a picture. Apps without a
 * registration (a program with a personal key) have no mark and are drawn by their initials.
 * `clients`: [{ clientName, logoUri, clientUri, redirectUris }].
 */
export function appMarks(clients, logoOf) {
  const marks = {};
  for (const client of clients) {
    const name = client?.clientName;
    if (!name || marks[name]) continue;
    const logo = typeof client.logoUri === 'string' && client.logoUri.startsWith('https://') ? client.logoUri : null;
    const address = [client.clientUri, ...(client.redirectUris ?? [])].find(value => typeof value === 'string' && /^https:\/\//.test(value));
    const host = address ? new URL(address).hostname : null;
    marks[name] = { picture: logo ?? (host ? logoOf(host) || null : null), site: host };
  }
  return marks;
}
