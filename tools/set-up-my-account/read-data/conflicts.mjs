// Two versions of one workspace record, kept together when its expected identity no longer matches.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const identity = value => `1f:${bytesToHex(blake3(bytes(value)))}`;
const branchKey = branch => `${branch.found ? '1' : '0'}:${branch.identity ?? ''}`;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export const workspaceConflictLabel = id => `workspace-conflict:${id}`;

/** A persisted per-person hybrid logical clock; receiving a later clock is handled by the same rule as local time. */
export function tickHybridClock(previous, received, now, deviceId = 'person-store') {
  const p = previous ?? { wall_ms: 0, logical: 0 };
  const r = received ?? { wall_ms: 0, logical: 0 };
  const wall = Math.max(now, p.wall_ms, r.wall_ms);
  const logical = wall === p.wall_ms && wall === r.wall_ms ? Math.max(p.logical, r.logical) + 1
    : wall === p.wall_ms ? p.logical + 1 : wall === r.wall_ms ? r.logical + 1 : 0;
  return { wall_ms: wall, logical, device_id: deviceId };
}

/** The ID and branch order are independent of which writer noticed the same fork first. */
export function makeWorkspaceConflict({ address, currentFound, currentValue, incomingFound = true, incomingValue, expectedIdentity, clock }) {
  const candidates = [
    { found: currentFound, identity: currentFound ? identity(currentValue) : 'missing', ...(currentFound ? { value: currentValue } : {}) },
    { found: incomingFound, identity: incomingFound ? identity(incomingValue) : 'missing', ...(incomingFound ? { value: incomingValue } : {}) },
  ];
  const branches = [...new Map(candidates.map(branch => [branchKey(branch), branch])).values()]
    .sort((a, b) => lexical(branchKey(a), branchKey(b)));
  const id = `1f:${bytesToHex(blake3(bytes([address, branches.map(({ found, identity: id }) => [found, id])])))}`;
  const currentIdentity = currentFound ? identity(currentValue) : 'missing';
  return { id, address, expected_identity: expectedIdentity ?? null, current_identity: currentIdentity, clock, state: 'open', branches };
}

export const workspaceValueIdentity = identity;

// Shared SQL realization. Hosts reach it through workspaceRecordSql below: a warm request runs no schema statement,
// and a statement refused for a missing workspace table realizes the whole schema once, in that same call, and runs
// again. No existence flag is kept, so a rolled-back or reset table is realized again by the next statement that needs it.
const missingWorkspaceTable = error => /\bno such table:\s*(?:main\.)?workspace_[a-z_]+\b/i.test(String(error?.message ?? error));
// A store whose version table predates version kinds gains the column the first time a query names it.
const missingRevisionKind = error => /\bno such column:\s*kind\b/i.test(String(error?.message ?? error));
function addRevisionKind(sql) {
  const columns = sql.exec('PRAGMA table_info(workspace_document_revisions)').toArray().map(row => row.name);
  if (!columns.includes('kind')) sql.exec("ALTER TABLE workspace_document_revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'save'");
}
export function workspaceRecordSql(sql) {
  return new Proxy(sql, {
    get(target, key) {
      if (key === 'exec') return (query, ...bindings) => {
        try { return target.exec(query, ...bindings); }
        catch (error) {
          if (missingRevisionKind(error)) addRevisionKind(target);
          else if (missingWorkspaceTable(error)) setupWorkspaceRecordTables(target);
          else throw error;
          return target.exec(query, ...bindings);
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export function setupWorkspaceRecordTables(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_records (label TEXT PRIMARY KEY, value TEXT NOT NULL, written_at TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_document_revisions (revision_id TEXT PRIMARY KEY, address TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT \'\', identity TEXT NOT NULL, value TEXT NOT NULL, written_at TEXT NOT NULL, author TEXT, sequence INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT \'save\')');
  addRevisionKind(sql);
  // What one admitted AI command changed, member by member (src/native-workspace-records.mjs turns): the version before
  // it and the one it left (null: the member was not there), so the whole turn can be put back together.
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_revision_turns (turn TEXT NOT NULL, address TEXT NOT NULL, scope_id TEXT NOT NULL, before_identity TEXT, after_identity TEXT, at TEXT NOT NULL, author TEXT, PRIMARY KEY(turn, address, scope_id))');
  sql.exec('CREATE INDEX IF NOT EXISTS workspace_revision_turns_at ON workspace_revision_turns(at, turn)');
  sql.exec('CREATE INDEX IF NOT EXISTS workspace_document_revisions_address_scope_sequence ON workspace_document_revisions(address, scope_id, sequence DESC)');
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_document_revision_counters (address TEXT NOT NULL, scope_id TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, next_sequence INTEGER NOT NULL DEFAULT 1, omitted_at TEXT, PRIMARY KEY(address, scope_id))');
  sql.exec('CREATE INDEX IF NOT EXISTS workspace_document_revisions_oldest ON workspace_document_revisions(written_at,revision_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_document_revision_budget (id INTEGER PRIMARY KEY CHECK (id = 1), total_bytes INTEGER NOT NULL DEFAULT 0, total_count INTEGER NOT NULL DEFAULT 0)');
  sql.exec('INSERT OR IGNORE INTO workspace_document_revision_budget(id,total_bytes,total_count) VALUES(1,0,0)');
  sql.exec("CREATE TABLE IF NOT EXISTS workspace_document_erasures (address TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', erased_identity TEXT, erased_at TEXT NOT NULL, PRIMARY KEY(address,scope_id))");
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_hybrid_clock (id INTEGER PRIMARY KEY CHECK (id = 1), wall_ms INTEGER NOT NULL, logical INTEGER NOT NULL, device_id TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS workspace_conflict_index (label TEXT PRIMARY KEY, id TEXT NOT NULL, address TEXT NOT NULL, current_identity TEXT NOT NULL, wall_ms INTEGER NOT NULL, logical INTEGER NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL)');
  return sql;
}
