// Point-affinity shards own independent single-identity binding and reads.
// The directory retains legacy bindings and multi-identity relationship decisions.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const originalWorkIdentityKey = identity => {
  if (!object(identity) || typeof identity.kind !== 'string' || !identity.kind.trim()
    || typeof identity.id !== 'string' || !identity.id.trim() || identity.id.length > 2048)
    throw new TypeError('A bounded original work identity is required.');
  return `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(stable([identity.kind, identity.id])))))}`;
};
const identityKey = originalWorkIdentityKey;
export function initializeOriginalWorkSourceInventory(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS original_work_source_inventory (identity_key TEXT PRIMARY KEY,kind TEXT NOT NULL,identity_id TEXT NOT NULL,source TEXT NOT NULL)');
}
export function recordOriginalWorkSourceIdentities(sql,identities,source) {
  initializeOriginalWorkSourceInventory(sql);
  if(!Array.isArray(identities)||typeof source!=='string'||!source)throw new TypeError('Original source identities and provenance are required.');
  for(const identity of identities){
    const key=identityKey(identity);
    sql.exec('INSERT OR IGNORE INTO original_work_source_inventory VALUES(?,?,?,?)',key,identity.kind,identity.id,source);
  }
}
export function originalWorkSourceInventoryPage(sql,{after='',limit=100}={}) {
  initializeOriginalWorkSourceInventory(sql);
  if(typeof after!=='string'||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Read at most 100 original source identities.');
  const rows=sql.exec('SELECT identity_key,kind,identity_id,source FROM original_work_source_inventory WHERE identity_key>? ORDER BY identity_key LIMIT ?',after,limit+1).toArray();
  return {items:rows.slice(0,limit).map(row=>({identity_key:row.identity_key,identity:{kind:row.kind,id:row.identity_id},source:row.source})),after:rows.length>limit?rows[limit-1].identity_key:null};
}
export function hasOriginalWorkSourceIdentity(sql,identity) {
  initializeOriginalWorkSourceInventory(sql);
  return sql.exec('SELECT 1 FROM original_work_source_inventory WHERE identity_key=? LIMIT 1',identityKey(identity)).toArray().length===1;
}
export const originalWorkAffinityName = (owner, identity) => {
  if (typeof owner !== 'string' || !owner) throw new TypeError('An original-work account owner is required.');
  return `original-work-affinity:${JSON.stringify([owner, identityKey(identity)])}`;
};

export function initializeOriginalWorkAffinity(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS original_work_affinity_groups (owner TEXT NOT NULL,generation TEXT NOT NULL,identity_key TEXT NOT NULL,group_id TEXT NOT NULL,PRIMARY KEY(owner,generation,identity_key))');
  sql.exec(`CREATE TABLE IF NOT EXISTS original_work_resource_affinity (
    owner TEXT NOT NULL, generation TEXT NOT NULL, identity_key TEXT NOT NULL,
    kind TEXT NOT NULL, identity_id TEXT NOT NULL, resource_json TEXT,
    state TEXT NOT NULL, tombstone_json TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(owner,generation,identity_key))`);
  sql.exec('CREATE INDEX IF NOT EXISTS original_work_affinity_point ON original_work_resource_affinity(owner,identity_key,updated_at DESC,generation DESC)');
}

const checkOwner = (owner, resource) => {
  if (typeof owner !== 'string' || !owner || !object(resource) || resource.owner !== owner
    || typeof resource.resource !== 'string' || !resource.resource)
    throw new TypeError('The original work affinity must name an addressed resource owned by this account.');
};

export function readOriginalWorkAffinity(sql, owner, identity, generation = null) {
  initializeOriginalWorkAffinity(sql);
  const key = identityKey(identity);
  const rows = generation===null ? sql.exec('SELECT generation,resource_json,state,tombstone_json FROM original_work_resource_affinity WHERE owner=? AND identity_key=? ORDER BY updated_at DESC,generation DESC LIMIT 1',owner,key).toArray() : sql.exec('SELECT generation,resource_json,state,tombstone_json FROM original_work_resource_affinity WHERE owner=? AND identity_key=? AND generation=? LIMIT 1',owner,key,generation).toArray();
  const row = rows[0];
  if (!row) return null;
  if (row.state === 'tombstone') throw fail('resource_selection_tombstoned', 'This original work identity has been tombstoned and cannot be rebound.');
  if (row.state !== 'bound' || !row.resource_json) throw fail('resource_selection_corrupt', 'The original work affinity has an unknown durable state.');
  const group=sql.exec('SELECT group_id FROM original_work_affinity_groups WHERE owner=? AND generation=? AND identity_key=? LIMIT 1',owner,row.generation,key).toArray()[0]?.group_id??null;
  return { generation: row.generation, resource: JSON.parse(row.resource_json), ...(group?{group}: {}) };
}

export function bindOriginalWorkAffinity(sql, owner, { generation, identity, resource, group = null }) {
  initializeOriginalWorkAffinity(sql);
  if (typeof generation !== 'string' || !generation) throw new TypeError('An original-work generation is required.');
  checkOwner(owner, resource);
  const key = identityKey(identity), identityJson = JSON.stringify({ kind: identity.kind, id: identity.id });
  const resourceJson = JSON.stringify({ owner: resource.owner, resource: resource.resource });
  if(group){
    const old=sql.exec('SELECT group_id FROM original_work_affinity_groups WHERE owner=? AND generation=? AND identity_key=? LIMIT 1',owner,generation,key).toArray()[0];
    if(old&&old.group_id!==group)throw fail('resource_selection_conflict','This original identity already belongs to another atomic group.');
    sql.exec('INSERT OR IGNORE INTO original_work_affinity_groups VALUES(?,?,?,?)',owner,generation,key,group);
  }
  const prior = sql.exec('SELECT resource_json,state FROM original_work_resource_affinity WHERE owner=? AND generation=? AND identity_key=? LIMIT 1', owner, generation, key).toArray()[0];
  if (prior) {
    if (prior.state === 'tombstone') throw fail('resource_selection_tombstoned', 'This original work identity has been tombstoned and cannot be rebound.');
    if (prior.state !== 'bound' || prior.resource_json !== resourceJson) throw fail('resource_selection_conflict', 'The original work identity is already bound to another resource.');
    return { bound: true, repeated: true, generation, resource };
  }
  const at = new Date().toISOString();
  sql.exec('INSERT INTO original_work_resource_affinity VALUES(?,?,?,?,?,?,?, ?,?)', owner, generation, key, identity.kind, identity.id, resourceJson, 'bound', null, at);
  return { bound: true, repeated: false, generation, resource };
}

export function tombstoneOriginalWorkAffinity(sql, owner, { generation, identity, reason }) {
  initializeOriginalWorkAffinity(sql);
  if (typeof generation !== 'string' || !generation || typeof reason !== 'string' || !reason.trim()) throw new TypeError('A generation and tombstone reason are required.');
  const key = identityKey(identity), at = new Date().toISOString();
  const note = JSON.stringify({ reason, at });
  const prior = sql.exec('SELECT state FROM original_work_resource_affinity WHERE owner=? AND generation=? AND identity_key=? LIMIT 1', owner, generation, key).toArray()[0];
  if (prior?.state === 'tombstone') return { tombstoned: false, generation };
  sql.exec(`INSERT INTO original_work_resource_affinity VALUES(?,?,?,?,?,NULL,'tombstone',?,?)
    ON CONFLICT(owner,generation,identity_key) DO UPDATE SET state='tombstone',resource_json=NULL,tombstone_json=excluded.tombstone_json,updated_at=excluded.updated_at`,
  owner, generation, key, identity.kind, identity.id, note, at);
  return { tombstoned: true, generation };
}

/** Import one already-authorized affinity into its receiving point shard.
 * The caller supplies only the stable identity/group and mapped destination;
 * credentials and source resource data never cross this boundary. */
export function takeOriginalWorkAffinity(sql, owner, { generation, identity, resource, group = null }) {
  return bindOriginalWorkAffinity(sql, owner, { generation, identity, resource, group });
}
