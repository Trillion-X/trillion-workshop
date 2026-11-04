// Resource-local policy snapshots and admission fences for Space content owners.
// The Network remains the authority for policy mutations. A content owner receives a bounded,
// revisioned copy of only the rows needed to decide access to one Space.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

const PAGE_MAX = 100;
const TABLES = Object.freeze({
  memberships: { order: 'id', scope: 'chain', key: row => row.id },
  members: { order: 'membership_id, relay', scope: 'chain', key: row => `${row.membership_id}\u0000${row.relay}` },
  communities: { order: 'id', scope: 'chain', key: row => row.id },
  space_rules: { order: 'space_id', scope: 'chain', key: row => row.space_id },
  space_member_types: { order: 'space_id, type_id', scope: 'chain', key: row => `${row.space_id}\u0000${row.type_id}` },
  space_show_rule_types: { order: 'space_id', scope: 'chain', key: row => row.space_id },
  relays: { order: 'relay', scope: 'relays', key: row => row.relay },
  relay_holds: { order: 'relay', scope: 'relays', key: row => row.relay },
  // Only joins_as is policy input. Activity, picture, colour and share_generation belong to Space state.
  space_state: { order: 'space_id', scope: 'chain', key: row => row.space_id, select: 'space_id, joins_as' },
  space_tool_grants: { order: 'grant_id', scope: 'chain', key: row => row.grant_id },
  match_settings: { order: 'community_id, relay', scope: 'chain', key: row => `${row.community_id}\u0000${row.relay}` },
  match_rounds: { order: 'id', scope: 'chain', key: row => row.id },
  matches: { order: 'id', scope: 'chain', key: row => row.id },
  match_asks: { order: 'round_id, relay', scope: 'rounds', key: row => `${row.round_id}\u0000${row.relay}` },
});
const contexts = new AsyncLocalStorage();
const active = new WeakMap();
const initializedOwners = new WeakSet();

const rowsOf = result => result.toArray();
const assertSql = sql => {
  if (!sql || typeof sql.exec !== 'function') throw new TypeError('A synchronous SQLite owner is required.');
};
const assertSpaceId = id => {
  if (typeof id !== 'string' || !id || id.length > 500) throw new TypeError('A Space id is required.');
};
const json = value => JSON.stringify(value);

function ensureTables(sql) {
  assertSql(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS content_policy_meta (
    space_id TEXT PRIMARY KEY, active_revision TEXT, pending_revision TEXT,
    expected_manifest TEXT, next_epoch INTEGER NOT NULL DEFAULT 0,
    fence_id TEXT, fenced INTEGER NOT NULL DEFAULT 0, fence_manifest TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS content_policy_rows (
    space_id TEXT NOT NULL, revision TEXT NOT NULL, table_name TEXT NOT NULL,
    row_key TEXT NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(space_id, revision, table_name, row_key)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS content_policy_pages (
    space_id TEXT NOT NULL, revision TEXT NOT NULL, table_name TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(space_id, revision, table_name)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS content_policy_page_receipts (
    space_id TEXT NOT NULL, revision TEXT NOT NULL, table_name TEXT NOT NULL,
    cursor INTEGER NOT NULL, row_count INTEGER NOT NULL, complete INTEGER NOT NULL,
    PRIMARY KEY(space_id, revision, table_name, cursor)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS content_policy_fences (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    state TEXT NOT NULL, manifest TEXT NOT NULL, changed_at TEXT NOT NULL
  )`);
}

function chainIds(sql, spaceId) {
  const result = [];
  const seen = new Set();
  let current = spaceId;
  while (current && !seen.has(current)) {
    if (result.length >= 1000) throw new Error('Space parent chain exceeds the policy snapshot bound.');
    seen.add(current);
    const row = rowsOf(sql.exec('SELECT id, parent_id FROM memberships WHERE id = ?', current))[0];
    if (!row) break;
    result.push(row.id);
    current = row.parent_id ?? null;
  }
  return result;
}

function selectScope(sql, table, spaceId) {
  const spec = TABLES[table];
  if (!spec) throw new TypeError(`Unsupported policy table: ${table}`);
  const ids = chainIds(sql, spaceId);
  const idsSql = ids.length ? ids.map(() => '?').join(',') : "''";
  const eventIds = `(SELECT id FROM memberships WHERE parent_id = ?)`;
  const eventParams = table === 'memberships' || table === 'members' ? [spaceId] : [];
  if (spec.scope === 'chain') {
    let column = 'space_id';
    if (table === 'memberships' || table === 'communities' || table === 'match_rounds' || table === 'matches') column = 'id';
    if (table === 'members') column = 'membership_id';
    if (table === 'match_settings') column = 'community_id';
    if (table === 'space_tool_grants' || table === 'space_marketplace_owned_grants') column = 'space_id';
    if (table === 'memberships' || table === 'members') return { where: `${column} IN (${idsSql}) OR ${column} IN ${eventIds}`, params: [...ids, ...eventParams] };
    if (table === 'match_rounds') return { where: `community_id IN (${idsSql})`, params: ids };
    if (table === 'matches') return { where: `community_id IN (${idsSql})`, params: ids };
    return { where: `${column} IN (${idsSql})`, params: ids };
  }
  if (spec.scope === 'rounds') return { where: `round_id IN (SELECT id FROM match_rounds WHERE community_id IN (${idsSql}))`, params: ids };
  const memberships = `membership_id IN (${idsSql}) OR membership_id IN ${eventIds}`;
  const params = [...ids, spaceId];
  return { where: `relay IN (SELECT DISTINCT relay FROM members WHERE ${memberships})`, params };
}

function sourcePageCursor(after, spaceId, table, columns) {
  if (after === 0) return { offset: 0, values: null };
  if (typeof after !== 'string' || !after || after.length > 4096) throw new TypeError('Policy page cursor must be zero or a bounded opaque page cursor.');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
  catch { throw new TypeError('Policy page cursor is invalid.'); }
  if (cursor?.version !== 1 || cursor.spaceId !== spaceId || cursor.table !== table ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset < 1 ||
      !Array.isArray(cursor.values) || cursor.values.length !== columns.length ||
      cursor.values.some(value => value === null || !['string', 'number'].includes(typeof value))) {
    throw new TypeError('Policy page cursor does not match this Space and table.');
  }
  return cursor;
}

/** The bounded source page size and scope are explicit so callers can transport one page at a time. */
export function policyPage(sql, spaceId, table, after = 0, limit = PAGE_MAX) {
  assertSql(sql); assertSpaceId(spaceId);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new RangeError(`Policy pages must contain 1 to ${PAGE_MAX} rows.`);
  const spec = TABLES[table];
  if (!spec) throw new TypeError(`Unsupported policy table: ${table}`);
  const { where, params } = selectScope(sql, table, spaceId);
  const select = spec.select ?? '*';
  const columns = spec.order.split(',').map(column => column.trim());
  const cursor = sourcePageCursor(after, spaceId, table, columns);
  const seek = cursor.values ? ` AND (${columns.join(', ')}) > (${columns.map(() => '?').join(', ')})` : '';
  const found = rowsOf(sql.exec(`SELECT ${select} FROM ${table} WHERE (${where})${seek} ORDER BY ${spec.order} LIMIT ?`,
    ...params, ...(cursor.values ?? []), limit + 1));
  const done = found.length <= limit;
  const page = found.slice(0, limit);
  const nextCursor = done ? null : Buffer.from(JSON.stringify({
    version: 1, spaceId, table, offset: cursor.offset + page.length,
    values: columns.map(column => page.at(-1)[column]),
  })).toString('base64url');
  return { rows: page, cursor: cursor.offset, nextCursor, done };
}

/** Manifest counts are bounded aggregates over the declared per-Space policy scope. */
export function policyManifest(sql, spaceId) {
  assertSql(sql); assertSpaceId(spaceId);
  const tables = {};
  for (const table of Object.keys(TABLES)) {
    const { where, params } = selectScope(sql, table, spaceId);
    tables[table] = rowsOf(sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, ...params))[0]?.count ?? 0;
  }
  return { version: 1, spaceId, pageSize: PAGE_MAX, tables };
}

export function setupContentPolicy(sql) { ensureTables(sql); }

// Publication already verifies and materializes explicit zero counts. Sending
// an empty page for each such table adds independent metered shard commands
// without carrying any rows. One page still establishes an all-empty revision.
export function policyTablesToStage(manifest) {
  const tables = Object.keys(manifest.tables);
  const populated = tables.filter(table => manifest.tables[table] > 0);
  return populated.length ? populated : tables.slice(0, 1);
}

/** Persist one page into an isolated revision. The active mirror is never modified while staging. */
export function acceptPolicyPage(sql, input) {
  const { spaceId, revision, manifest, table, rows, nextCursor = input.next_cursor ?? null, done = false } = input;
  ensureTables(sql); assertSpaceId(spaceId);
  if (typeof revision !== 'string' || !revision || revision.length > 500) throw new TypeError('A policy revision is required.');
  if (!TABLES[table] || !Array.isArray(rows) || rows.length > PAGE_MAX) throw new TypeError('A bounded policy page is required.');
  if (!manifest || manifest.spaceId !== spaceId || manifest.version !== 1 || !Number.isInteger(manifest.tables?.[table])) throw new TypeError('The matching policy manifest is required.');
  const row = rowsOf(sql.exec('SELECT active_revision, pending_revision, expected_manifest FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  // A page of a revision already published here is a replay; restaging it would discard the active rows.
  if (row?.active_revision === revision && !row.pending_revision) {
    const total = rowsOf(sql.exec('SELECT row_count FROM content_policy_pages WHERE space_id = ? AND revision = ? AND table_name = ?', spaceId, revision, table))[0]?.row_count ?? 0;
    return { accepted: 0, total, complete: true, replay: true, published: true };
  }
  if (!row || row.pending_revision !== revision || row.expected_manifest !== json(manifest)) {
    sql.exec(`INSERT INTO content_policy_meta (space_id, pending_revision, expected_manifest)
      VALUES (?, ?, ?) ON CONFLICT(space_id) DO UPDATE SET pending_revision = excluded.pending_revision, expected_manifest = excluded.expected_manifest`, spaceId, revision, json(manifest));
    sql.exec('DELETE FROM content_policy_rows WHERE space_id = ? AND revision = ?', spaceId, revision);
    sql.exec('DELETE FROM content_policy_pages WHERE space_id = ? AND revision = ?', spaceId, revision);
    sql.exec('DELETE FROM content_policy_page_receipts WHERE space_id = ? AND revision = ?', spaceId, revision);
  }
  const cursor = Number.isInteger(input.cursor) ? input.cursor : null;
  const pageCursor = cursor ?? rowsOf(sql.exec('SELECT COALESCE(MAX(cursor + row_count), 0) AS cursor FROM content_policy_page_receipts WHERE space_id = ? AND revision = ? AND table_name = ?', spaceId, revision, table))[0]?.cursor ?? 0;
  const receipt = rowsOf(sql.exec('SELECT row_count, complete FROM content_policy_page_receipts WHERE space_id = ? AND revision = ? AND table_name = ? AND cursor = ?', spaceId, revision, table, pageCursor))[0];
  if (receipt) {
    if (receipt.row_count !== rows.length || Boolean(receipt.complete) !== Boolean(done)) throw new Error(`Policy page replay conflicts for ${table} at ${pageCursor}.`);
    for (const value of rows) {
      const key = TABLES[table].key(value);
      const saved = rowsOf(sql.exec('SELECT value_json FROM content_policy_rows WHERE space_id = ? AND revision = ? AND table_name = ? AND row_key = ?',spaceId,revision,table,key))[0];
      if (!saved || saved.value_json !== json(value)) throw new Error(`Policy page replay conflicts for ${table} at ${pageCursor}.`);
    }
    const total = rowsOf(sql.exec('SELECT row_count FROM content_policy_pages WHERE space_id = ? AND revision = ? AND table_name = ?', spaceId, revision, table))[0]?.row_count ?? 0;
    return { accepted: 0, total, complete: Boolean(receipt.complete), replay: true };
  }
  const page = rowsOf(sql.exec('SELECT row_count, complete FROM content_policy_pages WHERE space_id = ? AND revision = ? AND table_name = ?', spaceId, revision, table))[0];
  if (pageCursor !== (page?.row_count ?? 0)) throw new Error(`Policy page cursor for ${table} is out of order.`);
  if (page?.complete) throw new Error(`Policy table ${table} is already complete for this revision.`);
  for (const value of rows) {
    if (!value || typeof value !== 'object') throw new TypeError(`Invalid ${table} policy row.`);
    const key = TABLES[table].key(value);
    if (typeof key !== 'string' || !key) throw new TypeError(`A ${table} policy row has no stable key.`);
    sql.exec('INSERT INTO content_policy_rows (space_id, revision, table_name, row_key, value_json) VALUES (?, ?, ?, ?, ?)', spaceId, revision, table, key, json(value));
  }
  const total = (page?.row_count ?? 0) + rows.length;
  if (total > manifest.tables[table]) throw new Error(`Policy table ${table} exceeds its manifest count.`);
  if (done && total !== manifest.tables[table]) throw new Error(`Policy table ${table} ended before its manifest count.`);
  if (!done && total >= manifest.tables[table]) throw new Error(`Policy table ${table} did not mark its final page complete.`);
  sql.exec(`INSERT INTO content_policy_pages (space_id, revision, table_name, row_count, complete) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(space_id, revision, table_name) DO UPDATE SET row_count = excluded.row_count, complete = excluded.complete`, spaceId, revision, table, total, done ? 1 : 0);
  sql.exec('INSERT INTO content_policy_page_receipts (space_id, revision, table_name, cursor, row_count, complete) VALUES (?, ?, ?, ?, ?, ?)', spaceId, revision, table, pageCursor, rows.length, done ? 1 : 0);
  return { accepted: rows.length, total, complete: Boolean(done) };
}

const quote = name => `"${String(name).replaceAll('"', '""')}"`;
function inChunks(values, fn) {
  for (let at = 0; at < values.length; at += PAGE_MAX) fn(values.slice(at, at + PAGE_MAX));
}
function deleteByIds(sql, table, column, ids) {
  inChunks([...new Set(ids.filter(value => typeof value === 'string' && value))], group => {
    if (group.length) sql.exec(`DELETE FROM ${quote(table)} WHERE ${quote(column)} IN (${group.map(() => '?').join(',')})`, ...group);
  });
}
function upsertRows(sql, table, rows, conflictColumns) {
  if (!rows.length) return;
  const available = new Set(rowsOf(sql.exec(`PRAGMA table_info(${quote(table)})`)).map(row => row.name));
  for (const row of rows) {
    const columns = Object.keys(row).filter(column => available.has(column));
    if (!columns.length) continue;
    const conflicts = conflictColumns.filter(column => columns.includes(column));
    if (conflicts.length !== conflictColumns.length) throw new Error(`The ${table} policy row is missing its key.`);
    const updates = columns.filter(column => !conflicts.includes(column));
    const suffix = updates.length
      ? `DO UPDATE SET ${updates.map(column => `${quote(column)} = excluded.${quote(column)}`).join(', ')}`
      : 'DO NOTHING';
    sql.exec(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(${conflicts.map(quote).join(', ')}) ${suffix}`,
      ...columns.map(column => row[column] ?? null));
  }
}

function materializePolicyRows(sql, spaceId, revision, manifest) {
  const incoming = Object.fromEntries(Object.keys(TABLES).map(table => [table,
    rowsOf(sql.exec('SELECT value_json FROM content_policy_rows WHERE space_id = ? AND revision = ? AND table_name = ? ORDER BY row_key', spaceId, revision, table)).map(row => JSON.parse(row.value_json))]));
  const currentRevision = rowsOf(sql.exec('SELECT active_revision FROM content_policy_meta WHERE space_id = ?', spaceId))[0]?.active_revision;
  const prior = currentRevision ? Object.fromEntries(Object.keys(TABLES).map(table => [table,
    rowsOf(sql.exec('SELECT value_json FROM content_policy_rows WHERE space_id = ? AND revision = ? AND table_name = ? ORDER BY row_key', spaceId, currentRevision, table)).map(row => JSON.parse(row.value_json))])) : {};
  const oldIds = prior.memberships?.map(row => row.id) ?? [];
  const newIds = incoming.memberships.map(row => row.id);
  const affectedIds = [...new Set([...oldIds, ...newIds])];
  const oldRelays = prior.members?.map(row => row.relay) ?? [];

  // Clear only policy rows in the previous/current chain. Content tables and non-policy Space state remain owned here.
  deleteByIds(sql, 'members', 'membership_id', affectedIds);
  deleteByIds(sql, 'communities', 'id', affectedIds);
  deleteByIds(sql, 'space_rules', 'space_id', affectedIds);
  deleteByIds(sql, 'space_member_types', 'space_id', affectedIds);
  deleteByIds(sql, 'space_show_rule_types', 'space_id', affectedIds);
  deleteByIds(sql, 'memberships', 'id', oldIds.filter(id => !newIds.includes(id)));
  deleteByIds(sql, 'space_tool_grants', 'space_id', affectedIds);
  deleteByIds(sql, 'match_asks', 'round_id', [...(prior.match_rounds ?? []), ...incoming.match_rounds].map(row => row.id));
  for (const table of ['match_settings','match_rounds','matches']) deleteByIds(sql, table, 'community_id', affectedIds);
  const newRelays = [...new Set(incoming.members.map(row => row.relay))];
  deleteByIds(sql, 'relay_holds', 'relay', [...new Set([...oldRelays, ...newRelays])]);

  upsertRows(sql, 'memberships', incoming.memberships, ['id']);
  upsertRows(sql, 'members', incoming.members, ['membership_id', 'relay']);
  upsertRows(sql, 'communities', incoming.communities, ['id']);
  upsertRows(sql, 'space_rules', incoming.space_rules, ['space_id']);
  upsertRows(sql, 'space_member_types', incoming.space_member_types, ['space_id', 'type_id']);
  upsertRows(sql, 'space_show_rule_types', incoming.space_show_rule_types, ['space_id']);
  upsertRows(sql, 'relays', incoming.relays, ['relay']);
  upsertRows(sql, 'relay_holds', incoming.relay_holds, ['relay']);
  upsertRows(sql, 'space_tool_grants', incoming.space_tool_grants, ['grant_id']);
  upsertRows(sql, 'match_settings', incoming.match_settings, ['community_id', 'relay']);
  upsertRows(sql, 'match_rounds', incoming.match_rounds, ['id']);
  upsertRows(sql, 'matches', incoming.matches, ['id']);
  upsertRows(sql, 'match_asks', incoming.match_asks, ['round_id', 'relay']);
  for (const row of incoming.space_state) {
    sql.exec(`INSERT INTO space_state (space_id, last_activity_at, joins_as)
      VALUES (?, COALESCE((SELECT last_activity_at FROM space_state WHERE space_id = ?), ''), ?)
      ON CONFLICT(space_id) DO UPDATE SET joins_as = excluded.joins_as`, row.space_id, row.space_id, row.joins_as ?? null);
  }
  // An explicit check catches schema drift without allowing a partial active revision.
  for (const [table, count] of Object.entries(manifest.tables)) {
    if (incoming[table].length !== count) throw new Error(`The materialized ${table} policy rows do not match their manifest.`);
  }
}

export function materializePolicy(sql, spaceId, revision, manifest) {
  assertSql(sql); assertSpaceId(spaceId);
  materializePolicyRows(sql, spaceId, revision, manifest);
  return { materialized: true, spaceId, revision };
}

/** Install the current staged snapshot into the normal local readers and atomically acknowledge its fence. */
export function installPublishedPolicy(owner, spaceId, manifest = undefined, fenceProof = undefined) {
  if (spaceId && typeof spaceId === 'object') {
    const input = spaceId;
    spaceId = input.space_id ?? input.spaceId;
    manifest = input.manifest;
    fenceProof = input.fence;
  }
  const sql = stateFor(owner);
  const row = rowsOf(sql.exec('SELECT pending_revision, expected_manifest, fence_id, next_epoch, fenced FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (!row?.pending_revision || !row.expected_manifest) throw new Error('No complete staged Space policy snapshot is awaiting installation.');
  const expected = JSON.parse(row.expected_manifest);
  if (manifest && json(manifest) !== row.expected_manifest) throw new Error('The policy manifest changed before installation.');
  if (row.fenced && !row.fence_id) throw new Error('A durable content fence id is missing.');
  const durable = row.fenced ? rowsOf(sql.exec('SELECT epoch, manifest, state FROM content_policy_fences WHERE id = ?', row.fence_id))[0] : null;
  if (row.fenced && (!durable || durable.state !== 'fenced' || !fenceProof || fenceProof.id !== row.fence_id || fenceProof.epoch !== durable.epoch || json(fenceProof.manifest) !== durable.manifest)) throw new Error('The durable fence proof does not match the staged policy.');
  const revision = row.pending_revision;
  return publishPolicy(sql, { spaceId, revision, manifest: expected, owner, fence: fenceProof });
}

/** The only publication step: switch the active revision after every declared table is complete. */
export function publishPolicy(sql, { spaceId, revision, manifest, owner = null, transaction = null, fence = undefined, keepFence = false }) {
  ensureTables(sql); assertSpaceId(spaceId);
  const staged = rowsOf(sql.exec('SELECT active_revision, pending_revision, expected_manifest FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (staged?.active_revision === revision && !staged.pending_revision) return { published: true, revision, replay: true };
  if (!staged || staged.pending_revision !== revision || staged.expected_manifest !== json(manifest)) throw new Error('The policy snapshot is not the current staged revision.');
  for (const [table, expected] of Object.entries(manifest.tables ?? {})) {
    if (!TABLES[table] || !Number.isInteger(expected) || expected < 0) throw new Error('The policy manifest is invalid.');
    const page = rowsOf(sql.exec('SELECT row_count, complete FROM content_policy_pages WHERE space_id = ? AND revision = ? AND table_name = ?', spaceId, revision, table))[0];
    if (expected === 0 && !page) {
      sql.exec('INSERT INTO content_policy_pages (space_id, revision, table_name, row_count, complete) VALUES (?, ?, ?, 0, 1)', spaceId, revision, table);
      continue;
    }
    if (!page?.complete || page.row_count !== expected) throw new Error(`Policy table ${table} is incomplete.`);
  }
  if (Object.keys(manifest.tables ?? {}).length !== Object.keys(TABLES).length) throw new Error('The policy manifest omits required policy tables.');
  const meta = rowsOf(sql.exec('SELECT fenced, fence_id, fence_manifest FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (meta?.fenced && (!fence || meta.fence_id !== fence.id || meta.fence_manifest !== json(fence.manifest))) throw new Error('The policy publication does not match the durable content fence.');
  if (meta?.fenced) {
    const durable = rowsOf(sql.exec('SELECT epoch, manifest, state FROM content_policy_fences WHERE id = ?', fence.id))[0];
    if (!durable || durable.state !== 'fenced' || durable.epoch !== fence.epoch || durable.manifest !== json(fence.manifest)) throw new Error('The durable content fence proof is invalid.');
  }
  const commit = () => {
    const previousMembers = owner ? rowsOf(sql.exec("SELECT relay FROM members WHERE membership_id = ? AND state = 'member'", spaceId)).map(row => row.relay) : [];
    materializePolicyRows(sql, spaceId, revision, manifest);
    if (owner) for (const relay of previousMembers) if (!rowsOf(sql.exec("SELECT 1 FROM members WHERE membership_id = ? AND relay = ? AND state = 'member'", spaceId, relay)).length) owner.leaveSpaces(relay, spaceId);
    sql.exec('DELETE FROM content_policy_rows WHERE space_id = ? AND revision <> ?',spaceId,revision);
    sql.exec('DELETE FROM content_policy_pages WHERE space_id = ? AND revision <> ?',spaceId,revision);
    sql.exec('DELETE FROM content_policy_page_receipts WHERE space_id = ? AND revision <> ?',spaceId,revision);
    if (keepFence) sql.exec('UPDATE content_policy_meta SET active_revision = ?, pending_revision = NULL, expected_manifest = NULL WHERE space_id = ?', revision, spaceId);
    else {
      sql.exec(`UPDATE content_policy_meta SET active_revision = ?, pending_revision = NULL, expected_manifest = NULL, fenced = 0, fence_id = NULL, fence_manifest = NULL WHERE space_id = ?`, revision, spaceId);
      sql.exec("UPDATE content_policy_fences SET state = 'published', changed_at = ? WHERE space_id = ? AND state = 'fenced'", new Date().toISOString(), spaceId);
    }
  };
  const run = () => transaction ? transaction(commit) : owner?.ctx?.storage?.transactionSync ? owner.ctx.storage.transactionSync(commit) : commit();
  if (owner) withContentPolicyInternal(owner, run); else run();
  return { published: true, revision };
}

/** Read the currently published rows without exposing staged revisions. */
export function policyRows(sql, spaceId, table) {
  ensureTables(sql); assertSpaceId(spaceId);
  if (!TABLES[table]) throw new TypeError(`Unsupported policy table: ${table}`);
  const revision = rowsOf(sql.exec('SELECT active_revision FROM content_policy_meta WHERE space_id = ?', spaceId))[0]?.active_revision;
  if (!revision) throw new Error('No complete local Space policy snapshot is published.');
  return rowsOf(sql.exec('SELECT value_json FROM content_policy_rows WHERE space_id = ? AND revision = ? AND table_name = ? ORDER BY row_key', spaceId, revision, table)).map(row => JSON.parse(row.value_json));
}

/** Enumerate status in bounded, stable pages for owners that host several Spaces. */
export function contentPolicyStatusPage(sql, after = '', limit = PAGE_MAX) {
  ensureTables(sql);
  if (typeof after !== 'string' || after.length > 500) throw new TypeError('A Space status cursor is required.');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new RangeError(`Space status pages must contain 1 to ${PAGE_MAX} rows.`);
  const found = rowsOf(sql.exec('SELECT space_id, active_revision, pending_revision, fenced, fence_id, next_epoch FROM content_policy_meta WHERE space_id > ? ORDER BY space_id LIMIT ?', after, limit + 1));
  const rows = found.slice(0, limit);
  const done = found.length <= limit;
  return { rows, nextCursor: done ? null : rows.at(-1).space_id, done };
}

export function contentPolicyStatus(sql, spaceId = undefined) {
  if (spaceId && typeof spaceId === 'object') spaceId = spaceId.space_id ?? spaceId.spaceId;
  if (spaceId !== undefined) {
    ensureTables(sql);
    return rowsOf(sql.exec('SELECT space_id, active_revision, pending_revision, fenced, fence_id, next_epoch FROM content_policy_meta WHERE space_id = ?', spaceId))[0] ?? null;
  }
  const all = [];
  let after = '';
  for (;;) {
    const page = contentPolicyStatusPage(sql, after);
    all.push(...page.rows);
    if (page.done) return all;
    after = page.nextCursor;
  }
}

function stateFor(owner) {
  if (!owner || !owner.sql) throw new TypeError('A content owner with local SQL is required.');
  const sql = owner.contentPolicySql ?? owner.sql;
  if (!initializedOwners.has(owner)) { ensureTables(sql); initializedOwners.add(owner); }
  return sql;
}

/** Internal snapshot writes must pass through the SQL adapter without being mistaken for content effects. */
export function withContentPolicyInternal(owner, fn) {
  const parent = contexts.getStore();
  if (parent?.owner === owner) return contexts.run({ ...parent, internalPolicy: true }, fn);
  return contexts.run({ owner, internalPolicy: true }, fn);
}

export function isContentPolicyInternal(owner) {
  return contexts.getStore()?.owner === owner && contexts.getStore()?.internalPolicy === true;
}

export function contentInvocationActive(owner) {
  const context = contexts.getStore();
  return Boolean(context?.owner === owner && !context.internalPolicy);
}

/** Cheap guard hook for SQL adapters: no schema setup or SQL when no content invocation is active. */
export function ensureContentPolicyCurrentIfActive(owner) {
  const context = contexts.getStore();
  if (!context || context.owner !== owner || context.internalPolicy) return true;
  const sql = owner.contentPolicySql ?? owner.sql;
  const row = rowsOf(sql.exec('SELECT next_epoch, fenced, fence_id FROM content_policy_meta WHERE space_id = ?', context.spaceId))[0];
  if (!row || (row.fenced && row.fence_id !== context.fenceId) || row.next_epoch !== context.epoch) throw new Error('Space content policy changed during this invocation.');
  return true;
}

/** Capture a policy epoch before any content invocation can perform work. */
export function captureContentPolicyEpoch(owner, spaceId = undefined) {
  const sql = stateFor(owner);
  const context = contexts.getStore();
  if (context?.owner === owner) return context.epoch;
  const rows = spaceId === undefined
    ? rowsOf(sql.exec('SELECT next_epoch, fenced, active_revision FROM content_policy_meta ORDER BY space_id LIMIT 2'))
    : rowsOf(sql.exec('SELECT next_epoch, fenced, active_revision FROM content_policy_meta WHERE space_id = ?', spaceId));
  if (spaceId === undefined && rows.length > 1) throw new Error('A Space id is required when this owner serves multiple Spaces.');
  const row = rows[0];
  if (!row || !row.active_revision || row.fenced) throw new Error('Space content is fenced until its current policy snapshot is published.');
  return row.next_epoch;
}

/** Reject writes/reads from an admitted command whose policy epoch was fenced or replaced. */
export function assertContentPolicyCurrent(owner) {
  const context = contexts.getStore();
  if (context?.owner === owner && context.internalPolicy) return true;
  if (!context || context.owner !== owner) throw new Error('Space content access requires an admitted local invocation.');
  const sql = stateFor(owner);
  const current = rowsOf(sql.exec('SELECT next_epoch, fenced, fence_id FROM content_policy_meta WHERE space_id = ?', context.spaceId))[0];
  if (!current || (current.fenced && current.fence_id !== context.fenceId) || current.next_epoch !== context.epoch) throw new Error('Space content policy changed during this invocation.');
  return true;
}

/** Run one admitted content command and retain its completion promise until it fully settles. */
export async function withContentInvocation(owner, spaceId, fn) {
  if (typeof fn !== 'function') throw new TypeError('An invocation function is required.');
  const sql = stateFor(owner); assertSpaceId(spaceId);
  const currentContext = contexts.getStore();
  if (currentContext?.owner === owner && currentContext.spaceId === spaceId) {
    assertContentPolicyCurrent(owner);
    return fn({ epoch: currentContext.epoch, assertCurrent: () => assertContentPolicyCurrent(owner) });
  }
  const row = rowsOf(sql.exec('SELECT active_revision, next_epoch, fenced FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (!row?.active_revision || row.fenced) throw new Error('Space content is fenced until its current policy snapshot is published.');
  const epoch = row.next_epoch;
  let pending = active.get(owner);
  if (!pending) { pending = new Set(); active.set(owner, pending); }
  const promise = contexts.run({ owner, spaceId, epoch }, async () => {
    assertContentPolicyCurrent(owner);
    return fn({ epoch, assertCurrent: () => assertContentPolicyCurrent(owner) });
  });
  pending.add(promise);
  try { return await promise; }
  finally { pending.delete(promise); }
}

export async function withFencedContentInvocation(owner, spaceId, fence, fn) {
  const sql = stateFor(owner);
  const row = rowsOf(sql.exec('SELECT next_epoch, fenced, fence_id FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (!row?.fenced || row.fence_id !== fence?.id || row.next_epoch !== fence.epoch) throw new Error('The coordinated content command has lost its policy fence.');
  return contexts.run({ owner, spaceId, epoch: fence.epoch, fenceId: fence.id }, () => fn({ assertCurrent: () => assertContentPolicyCurrent(owner) }));
}

/** Persist a local fence before awaiting any older command; resolve only after every old effect settles. */
export async function contentFence(owner, input) {
  const { id, manifest } = input;
  const spaceId = input.spaceId ?? input.space_id;
  const sql = stateFor(owner); assertSpaceId(spaceId);
  if (typeof id !== 'string' || !id || id.length > 500) throw new TypeError('A fence id is required.');
  if (!manifest || manifest.spaceId !== spaceId) throw new TypeError('A matching policy manifest is required.');
  const existing = rowsOf(sql.exec('SELECT epoch, state, manifest FROM content_policy_fences WHERE id = ?', id))[0];
  if (existing && existing.state === 'fenced' && existing.manifest !== json(manifest)) throw new Error('Fence id is already bound to another policy manifest.');
  let meta = rowsOf(sql.exec('SELECT next_epoch FROM content_policy_meta WHERE space_id = ?', spaceId))[0];
  if (!meta) {
    sql.exec('INSERT INTO content_policy_meta (space_id) VALUES (?)', spaceId);
    meta = { next_epoch: 0 };
  }
  const epoch = existing?.epoch ?? meta.next_epoch + 1;
  sql.exec('UPDATE content_policy_meta SET next_epoch = ?, fenced = 1, fence_id = ?, fence_manifest = ? WHERE space_id = ?', epoch, id, json(manifest), spaceId);
  sql.exec(`INSERT INTO content_policy_fences (id, space_id, epoch, state, manifest, changed_at) VALUES (?, ?, ?, 'fenced', ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = 'fenced', manifest = excluded.manifest, changed_at = excluded.changed_at`, id, spaceId, epoch, json(manifest), new Date().toISOString());
  const pending = active.get(owner);
  while (pending?.size) await Promise.allSettled([...pending]);
  return { fenced: true, id, spaceId, epoch, manifest };
}

/** A matching complete policy publication is the only operation that removes this owner's fence. */
export function contentPublish(owner, input) {
  const id = input.id ?? input.fence?.id;
  const epoch = input.epoch ?? input.fence?.epoch;
  const manifest = input.manifest;
  const fence = input.fence ?? { id, epoch, manifest };
  const sql = stateFor(owner);
  const row = rowsOf(sql.exec('SELECT space_id, epoch, state, manifest FROM content_policy_fences WHERE id = ?', id))[0];
  if (!fence || !row || row.state !== 'fenced' || row.epoch !== fence.epoch || row.manifest !== json(fence.manifest)) throw new Error('The local content fence does not match this policy publication.');
  const meta = rowsOf(sql.exec('SELECT fence_id, fence_manifest FROM content_policy_meta WHERE space_id = ?', row.space_id))[0];
  if (meta?.fence_id !== fence.id || meta.fence_manifest !== json(fence.manifest)) throw new Error('The local content fence changed before publication.');
  // publishPolicy switches the full snapshot and clears this exact fence in the same local owner.
  const revision = rowsOf(sql.exec('SELECT pending_revision FROM content_policy_meta WHERE space_id = ?', row.space_id))[0]?.pending_revision;
  if (!revision) throw new Error('A complete staged policy revision is required before the fence can be removed.');
  const expected = rowsOf(sql.exec('SELECT expected_manifest FROM content_policy_meta WHERE space_id = ?', row.space_id))[0]?.expected_manifest;
  const stagedManifest = expected ? JSON.parse(expected) : null;
  if (json(stagedManifest) !== json(manifest)) throw new Error('The staged policy does not match the publication manifest.');
  return publishPolicy(sql, { spaceId: row.space_id, revision, manifest: stagedManifest, owner, fence });
}

export const contentPolicyPageSize = PAGE_MAX;
