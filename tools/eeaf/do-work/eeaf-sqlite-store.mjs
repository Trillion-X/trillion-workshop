// parts/eeaf/do-work/eeaf-sqlite-store.mjs
//
// THE ELEVEN EEAF TABLES AS PLAIN CODE OVER ANY SQLITE.
//
// Purpose
//   The EEAF data model (entity, entity_types, type_properties, participation,
//   attribute_fact, interaction_sets, interaction_set_members, bitemporal_facts,
//   IndexEngine, IndexInstance, IndexArtifact) as one module any SQLite host can
//   run: a Cloudflare Durable Object's `ctx.storage.sql`, Node's `node:sqlite`,
//   or anything else that answers `exec(query, ...params).toArray()`. The schema is
//   the canonical one from architect-societies/intake-desktop/04_Documentation/
//   PRD_EEAF_INTEGRATION.md Part 4; the row identities written into the log use the
//   canonical address grammar owned by crates/eeaf-addressing.
//
// Non-negotiable invariants
//   1. Every change is appended to bitemporal_facts (never edited), with the row it
//      changed (canonical address), a JSON patch, the transaction it belongs to, who
//      made it, when it logically happened and when it was recorded. Its rows leave the
//      database a whole generation at a time: sealLog, then sealedLogPage until every row
//      is kept elsewhere, then dropSealedLog (a person's store keeps them as files:
//      src/record-history.mjs).
//   2. attribute_fact, participation and set membership hold CURRENT state only; the
//      log is the history. A current-state row is replaced or removed, the log keeps
//      every earlier value.
//   3. A record is decomposed all the way down: a nested object is its own entity
//      linked by participation, a list of objects is an ordered interaction set whose
//      members are entities, and only scalars and lists of scalars are values. No
//      object is ever stored as one JSON text.
//   4. A write costs work proportional to the record it changes, never to the store:
//      a record's rows are found by id range, so nothing outside it is read.
//   5. Types, properties and roles are entities too, created the first time data uses
//      them; adding a field or a kind of record is DATA, never a migration.
//   6. The module names no product, no record kind and no field. Callers hand it a
//      root id, a type name and a JSON value.
//
// Key concepts
//   root record   one caller-owned JSON object stored under an id and a type name.
//   child entity  `${parent}/${field}` for a nested object; `${parent}/${field}/${n}`
//                 for the n-th object of a list, whose set is `${parent}/${field}`. The
//                 field is URI-encoded, so a root id never contains `/`.
//   shared child  a nested object the caller marks content-addressed: stored once
//                 under the id `contentId` returns, linked from every record using it,
//                 never removed by one record's change.
//   type id       `type:${name}`, child types `type:${parent}/${field}`.
//   property id   `prop:${typeName}:${field}`; role id `role:${field}`.
//
// Security
//   The module holds no credential and runs no network request. Partitioning between
//   people is the host's job (one database per person); nothing here reads across
//   databases.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The eleven tables, in dependency order, exactly as PRD_EEAF_INTEGRATION.md Part 4 defines them. */
// The log is written in generations. New changes go to `bitemporal_facts`; a host seals it (renames it to a sealed
// table named after its first row and starts a fresh one), copies the sealed table out page by page, then drops it.
// A dropped table costs no row written, while deleting its rows one by one costs one each (2026-10-05: a person store
// deleting archived log rows wrote 12 000 to 37 000 rows a minute). A log table has no key or index: rows are only
// ever appended and read back in the order they were written (rowid), so each logged change is one row written.
const LOG_TABLE = 'bitemporal_facts';
const SEALED_LOG = 'bitemporal_facts_sealed_';
const LOG_TABLE_SQL = name => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT NOT NULL, record_id TEXT NOT NULL, table_name TEXT NOT NULL, patch TEXT NOT NULL, transaction_id TEXT NOT NULL, actor_context TEXT NOT NULL, application_time TEXT NOT NULL, system_time TEXT NOT NULL DEFAULT (datetime('now')))`;

export const EEAF_CORE_TABLES = [
  { table: 'entity', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY)',
  ] },
  { table: 'entity_types', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS entity_types (entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, type_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, PRIMARY KEY (entity_id, type_id))',
    'CREATE INDEX IF NOT EXISTS idx_entity_types_type ON entity_types(type_id)',
    // A type's ids in id order, so a page of the newest ids is read from the index alone.
    'CREATE INDEX IF NOT EXISTS idx_entity_types_type_entity ON entity_types(type_id, entity_id)',
  ] },
  { table: 'type_properties', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS type_properties (type_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, property_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, PRIMARY KEY (type_id, property_id))',
    'CREATE INDEX IF NOT EXISTS idx_type_properties_type ON type_properties(type_id)',
    'CREATE INDEX IF NOT EXISTS idx_type_properties_prop ON type_properties(property_id)',
  ] },
  { table: 'participation', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS participation (id TEXT PRIMARY KEY REFERENCES entity(id), interaction_id TEXT NOT NULL REFERENCES entity(id), participant_id TEXT NOT NULL REFERENCES entity(id), role_id TEXT NOT NULL REFERENCES entity(id), counterpart_id TEXT REFERENCES entity(id))',
    'CREATE INDEX IF NOT EXISTS idx_participation_interaction ON participation(interaction_id)',
    'CREATE INDEX IF NOT EXISTS idx_participation_participant ON participation(participant_id)',
    'CREATE INDEX IF NOT EXISTS idx_participation_counterpart ON participation(counterpart_id)',
    // Every column that references entity is indexed: removing an entity checks each of them, and an unindexed one
    // (role_id was) is a scan of every participation the store holds for every part a write removes.
    'CREATE INDEX IF NOT EXISTS idx_participation_role ON participation(role_id)',
  ] },
  { table: 'attribute_fact', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS attribute_fact (subject_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE, property_id TEXT NOT NULL REFERENCES entity(id), type_id TEXT NOT NULL, value_json TEXT, PRIMARY KEY (subject_id, property_id, type_id), FOREIGN KEY (type_id, property_id) REFERENCES type_properties(type_id, property_id))',
    'CREATE INDEX IF NOT EXISTS idx_attribute_fact_property ON attribute_fact(property_id)',
    'CREATE INDEX IF NOT EXISTS idx_attribute_fact_property_value_subject ON attribute_fact(property_id, value_json, subject_id)',
  ] },
  { table: 'interaction_sets', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS interaction_sets (id TEXT PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE, members_hash TEXT NOT NULL UNIQUE)',
  ] },
  { table: 'interaction_set_members', tier: 'knowledge-graph', statements: [
    'CREATE TABLE IF NOT EXISTS interaction_set_members (set_id TEXT NOT NULL REFERENCES interaction_sets(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES entity(id) ON DELETE RESTRICT, ordinal INTEGER, PRIMARY KEY (set_id, member_id))',
    'CREATE INDEX IF NOT EXISTS idx_set_members_set_ordinal ON interaction_set_members(set_id, ordinal)',
    'CREATE INDEX IF NOT EXISTS idx_set_members_member ON interaction_set_members(member_id)',
  ] },
  { table: 'bitemporal_facts', tier: 'bitemporal-log', statements: [
    LOG_TABLE_SQL('bitemporal_facts'),
    // How far each sealed log table has been kept elsewhere (its last kept rowid), so copying resumes after a restart.
    'CREATE TABLE IF NOT EXISTS bitemporal_facts_moves (sealed_table TEXT PRIMARY KEY, kept_through INTEGER NOT NULL) WITHOUT ROWID',
  ] },
  { table: 'IndexEngine', tier: 'index', statements: [
    'CREATE TABLE IF NOT EXISTS IndexEngine (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, wasm_module BLOB NOT NULL, parameter_schema TEXT NOT NULL)',
  ] },
  { table: 'IndexInstance', tier: 'index', statements: [
    "CREATE TABLE IF NOT EXISTS IndexInstance (id TEXT PRIMARY KEY, name TEXT NOT NULL, engine_id TEXT NOT NULL REFERENCES IndexEngine(id), source_filter TEXT NOT NULL, configuration TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'error', 'stale')))",
    'CREATE INDEX IF NOT EXISTS idx_instance_engine ON IndexInstance(engine_id)',
  ] },
  { table: 'IndexArtifact', tier: 'index', statements: [
    'CREATE TABLE IF NOT EXISTS IndexArtifact (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES IndexInstance(id) ON DELETE CASCADE, artifact_role TEXT NOT NULL, data_blob BLOB NOT NULL, version INTEGER NOT NULL DEFAULT 0)',
    'CREATE INDEX IF NOT EXISTS idx_artifact_instance ON IndexArtifact(instance_id)',
  ] },
];

// How many made-sure-of rows and assembled shared objects one store keeps in memory at most.
const KNOWN_KEPT = 20000;
const SHARED_KEPT = 500;
// Shared cache values use an estimated JS retained size, with this aggregate cap across all residents.
const SHARED_KEPT_BYTES = 8 * 1024 * 1024;
// A legal record can contain 8 MiB of UTF-8 JSON that expands into UTF-16 strings, arrays and object slots. Leave
// headroom for that representation and for its bounded clone while still refusing fan-out beyond one useful read.
const SHARED_EXPANSION_BYTES = 32 * 1024 * 1024;
// Records kept as the rows the database holds for them, so the next read of an unchanged record, and the next write to
// it, runs no query to find what it holds: at most this many records, this many bytes of memory in all, and none
// larger than RECORD_KEPT_BYTES (a bigger one is read again). Bytes are what the rows hold in memory (heldBytes): every
// id, property and value string plus a fixed cost per row, never only the values, whose text is a small part of a row
// (2026-10-05: counting value text alone let kept rows outgrow the isolate's memory and its alarms stopped).
const RECORDS_KEPT = 4000;
const RECORDS_KEPT_BYTES = 4 * 1024 * 1024;
const RECORD_KEPT_BYTES = 64 * 1024;
const ROW_OVERHEAD_BYTES = 96;
// Records opened by one batched read (readMany), and the longest value a batch takes in (a record holding a longer
// one is read on its own, where its size is counted exactly).
const READ_MANY = 100;
const READ_MANY_VALUE_BYTES = RECORD_KEPT_BYTES;
function heldBytes(rows) {
  let bytes = 0;
  for (const [id, type] of rows.entities) bytes += ROW_OVERHEAD_BYTES + id.length + (type?.length ?? 0);
  for (const [key, fact] of rows.facts) bytes += 2 * ROW_OVERHEAD_BYTES + key.length + fact.subject_id.length + fact.property_id.length + fact.type_id.length + fact.value_json.length;
  for (const [id, part] of rows.parts) bytes += 2 * ROW_OVERHEAD_BYTES + id.length + part.interaction_id.length + part.participant_id.length + part.role_id.length;
  for (const [id, members] of rows.sets) { bytes += ROW_OVERHEAD_BYTES + id.length; for (const member of members) bytes += 16 + member.length; }
  return bytes;
}

import { OBJECT_PROPERTY_BYTES, jsonExpansionBytes } from '../../json-expansion.mjs';
export { jsonExpansionBytes } from '../../json-expansion.mjs';

// Shared values are assembled JS objects, not just SQLite text. Estimate their retained and cloned footprint,
// including object/array slots and property names. Track identity so a nested shared reference is counted once per graph.
// Preflight and retained values share the same property-slot estimate; cache warmth cannot change admission.
function assembledBytes(value) {
  let bytes = 0;
  let rows = 0;
  const seen = new Set();
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    rows += 1;
    if (typeof item === 'string') { bytes += 16 + item.length * 2; continue; }
    if (item === null || typeof item !== 'object') { bytes += 16; continue; }
    if (seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      bytes += 32 + item.length * 8;
      for (const child of item) pending.push(child);
    } else {
      bytes += 64;
      for (const [key, child] of Object.entries(item)) {
        bytes += OBJECT_PROPERTY_BYTES + key.length * 2;
        pending.push(child);
      }
    }
  }
  return { rows, bytes };
}

// One memory of records' rows per database, shared by every store opened over it, so a write through any of them
// changes the record for all (a host that opens its store again, as after deleting everything, keeps one memory).
// The rows are the truth only because the store is the only writer of its tables and a rolled-back write forgets
// them all (forgetCached).
const recordMemories = new WeakMap();
function recordMemory() {
  const kept = new Map();
  let bytes = 0;
  const forget = id => { const held = kept.get(id); if (held) { bytes -= held.bytes; kept.delete(id); } };
  return {
    // Whether the record is known not to exist: read or written as absent, and not written since.
    absent: id => kept.has(id) && kept.get(id).rows === null,
    // The record's rows ({ entities, facts, parts, sets }), null when it is absent, or undefined when they are not kept;
    // reading them makes them the newest kept. Callers only read them: a write replaces them whole with keep().
    get(id) {
      const held = kept.get(id);
      if (!held) return undefined;
      kept.delete(id);
      kept.set(id, held);
      return held.rows;
    },
    keep(id, rows, size) {
      forget(id);
      if (size > RECORD_KEPT_BYTES) return;
      kept.set(id, { rows, bytes: size });
      bytes += size;
      while (kept.size > RECORDS_KEPT || bytes > RECORDS_KEPT_BYTES) forget(kept.keys().next().value);
    },
    forget,
    clear() { kept.clear(); bytes = 0; },
    size: () => ({ records: kept.size, bytes }),
  };
}
// One error for a record too large to read, whichever engine refuses it (parts/record-log owns it).
// Time-ordered log ids (UUIDv7) and the first id of a moment are the same for both engines too.
import { RecordTooLarge, logIdAt, uuidv7 } from '../../record-log/do-work/record-log-store.mjs';
export { RecordTooLarge, logIdAt };
const BOOT_TYPES = ['type:type', 'type:property', 'type:role', 'type:participation', 'type:set'];

// A record is read whole, so every row it holds is in memory at once. One that grew past these bounds (thousands of
// times any record the store's callers keep) is refused before a single row is read: it fails alone, with its sizes,
// instead of taking the memory of every other record the same database answers for. rows counts entities, values,
// links and list members; bytes counts the text of its values.
export const RECORD_BOUNDS = { rows: 30000, bytes: 8 * 1024 * 1024 };

export function retireUnusedEeafIndexes(sql) {
  // These three indexes duplicate the leftmost column of their tables' primary
  // keys. Retire them with the unused audit indexes before other schema work
  // to free pages without deleting records. The log's record and transaction
  // indexes go too: every logged change paid for them as two more rows written
  // (2026-10-05: a third of a person store's billed writes), and the log is only
  // ever read back in the order it was written, to move it out (sealedLogPage);
  // log() scans the hour or so the database still holds.
  for (const index of ['idx_bitemporal_table', 'idx_bitemporal_app_time', 'idx_bitemporal_sys_time', 'idx_bitemporal_record', 'idx_bitemporal_transaction', 'idx_attribute_fact_subject', 'idx_entity_types_entity', 'idx_set_members_set']) sql.exec(`DROP INDEX IF EXISTS ${index}`);
}

export function createEeafTables(sql) {
  retireUnusedEeafIndexes(sql);
  for (const { statements } of EEAF_CORE_TABLES) for (const statement of statements) sql.exec(statement);
}

// Every table the store creates, the ones other tables reference last: dropping a table no other table references
// runs no implicit delete of its rows (SQLite does that only for a table still referenced while foreign keys are on),
// so letting the store go costs no row written however many it holds.
const EEAF_TABLES_CHILDREN_FIRST = EEAF_CORE_TABLES.flatMap(({ statements }) => statements)
  .map(statement => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1]).filter(Boolean).reverse();
/** The next table of the store still in the database, children before the tables they reference, or null when none is
 *  left. The host lets it go a bounded piece at a time and drops it (a large table freed in one statement can outrun a
 *  storage operation's time). Sealed log generations are the host's to keep elsewhere and drop first (sealedLogs,
 *  dropSealedLog). */
export function nextEeafTable(sql) {
  const held = new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name));
  return EEAF_TABLES_CHILDREN_FIRST.find(name => held.has(name)) ?? null;
}

// The canonical address grammar of crates/eeaf-addressing (`escape_field`): NFC, then `\` -> `\\` and `|` -> `\|`.
function escapeField(value) {
  return String(value).normalize('NFC').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

// Field order per table is fixed here, as it is by the EeafRow enum; the last three tables extend the same grammar.
const ADDRESS_FIELDS = {
  entity: ['id'],
  entity_types: ['entity_id', 'type_id'],
  type_properties: ['type_id', 'property_id'],
  attribute_fact: ['subject_id', 'property_id', 'type_id'],
  participation: ['id'],
  interaction_sets: ['id'],
  interaction_set_members: ['set_id', 'member_id'],
};

/** `(table, row) -> canonical address string`, e.g. `attribute_fact|subject|property|type`. */
export function canonicalAddressString(table, row) {
  const fields = ADDRESS_FIELDS[table];
  if (!fields) throw new Error(`No canonical address for table ${table}`);
  return [table, ...fields.map(field => escapeField(row[field]))].join('|');
}


const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isListOfObjects = value => Array.isArray(value) && value.length > 0 && value.every(isObject);
const typeId = name => `type:${name}`;
// The first key after every valid Unicode string beginning with `prefix`. SQLite's default TEXT order is UTF-8
// byte order; incrementing the last scalar gives the indexed upper bound without treating %, _ or * as patterns.
const afterPrefix = prefix => {
  const points = Array.from(prefix);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index].codePointAt(0);
    if (value === 0x10ffff) continue;
    return points.slice(0, index).join('') + String.fromCodePoint(value === 0xd7ff ? 0xe000 : value + 1);
  }
  return null;
};
const propertyId = (typeName, field) => `prop:${typeName}:${field}`;
const roleId = field => `role:${field}`;
// A field name is one id segment; encoding keeps a field such as `a/b` from reading as two levels.
const segment = field => encodeURIComponent(field);
const partId = (parent, field) => `${parent}/${segment(field)}#part`;
// Every row of one record sits in [id, id + '/'...]: '0' is the character after '/'.
const rangeOf = id => [`${id}/`, `${id}0`];

// A record's rows as the store would hold them.
function decompose(rootId, rootType, value, contentId) {
  const rows = { entities: new Map(), facts: new Map(), parts: new Map(), sets: new Map(), shared: new Map() };
  const walk = (id, typeName, object) => {
    rows.entities.set(id, typeName);
    for (const [field, item] of Object.entries(object)) {
      if (item === undefined) continue;
      if (isObject(item)) {
        const childType = `${typeName}/${field}`;
        const sharedId = contentId?.(childType, item);
        if (sharedId) {
          rows.shared.set(sharedId, { typeName: childType, value: item });
          rows.parts.set(partId(id, field), { interaction_id: id, participant_id: sharedId, role_id: roleId(field) });
        } else {
          walk(`${id}/${segment(field)}`, childType, item);
          rows.parts.set(partId(id, field), { interaction_id: id, participant_id: `${id}/${segment(field)}`, role_id: roleId(field) });
        }
      } else if (isListOfObjects(item)) {
        const setId = `${id}/${segment(field)}`;
        rows.entities.set(setId, 'set');
        rows.sets.set(setId, item.map((member, ordinal) => {
          const memberId = `${setId}/${ordinal}`;
          walk(memberId, `${typeName}/${field}`, member);
          return memberId;
        }));
        rows.parts.set(partId(id, field), { interaction_id: id, participant_id: setId, role_id: roleId(field) });
      } else {
        rows.facts.set(`${id}\u0000${propertyId(typeName, field)}`, { subject_id: id, property_id: propertyId(typeName, field), type_id: typeId(typeName), value_json: JSON.stringify(item) });
      }
    }
  };
  walk(rootId, rootType, value);
  return rows;
}

/**
 * The store over one SQLite database.
 *   sql         { exec(query, ...params) -> { toArray() } }
 *   transaction (fn) -> result, running fn atomically (optional; defaults to calling fn)
 *   contentId   (typeName, value) -> id | null: a nested object stored once under that id
 *   hash        (text) -> text: identity of a set's member list (interaction_sets.members_hash)
 *   bounds      { rows, bytes }: past these one record is refused (RecordTooLarge) instead of read (RECORD_BOUNDS)
 */
export function eeafStore(sql, { transaction = fn => fn(), contentId = null, hash, bounds = RECORD_BOUNDS,
  sharedCacheBytes = SHARED_KEPT_BYTES, sharedExpansionBytes = SHARED_EXPANSION_BYTES }) {
  if (typeof hash !== 'function') throw new Error('eeafStore needs a hash function for set identities');
  if (!Number.isSafeInteger(bounds.rows) || bounds.rows < 1 || bounds.rows >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(bounds.bytes) || bounds.bytes < 1
    || !Number.isSafeInteger(sharedCacheBytes) || sharedCacheBytes < 1
    || !Number.isSafeInteger(sharedExpansionBytes) || sharedExpansionBytes < 1) throw new Error('eeafStore bounds must be positive safe integers');
  createEeafTables(sql);
  // Rows this store made sure of, so a write does not check them again. Every write adds to it and a store lives as
  // long as its Durable Object, so it is bounded: past KNOWN_KEPT it starts again, and a forgotten row costs one
  // indexed check the next time a write needs it.
  const known = new Set();
  const remember = key => { if (known.size >= KNOWN_KEPT) known.clear(); known.add(key); };
  // Opening a store starts its memory again: whatever the database held before (all of it deleted, say) is read anew.
  if (!recordMemories.has(sql)) recordMemories.set(sql, recordMemory());
  const records = recordMemories.get(sql);
  records.clear();
  const all = (query, ...params) => sql.exec(query, ...params).toArray();

  const uniquePairs = pairs => [...new Map(pairs.map(pair => [`${pair[0]}|${pair[1]}`, pair])).values()];

  function writer(context) {
    const at = context.system_time ?? new Date().toISOString();
    // Log rows wait here and go in a few statements at flush(), which every writer's user calls before it returns.
    const pending = [];
    const log = (table, row, op, value) => {
      pending.push([uuidv7(), canonicalAddressString(table, row), table, JSON.stringify(value === undefined ? { op } : { op, value }),
        context.transaction_id, JSON.stringify(context.actor ?? {}), context.application_time ?? at, at]);
    };
    const flush = () => {
      // 12 rows of 8 values: a statement binds at most 100.
      while (pending.length) {
        const rows = pending.splice(0, 12);
        sql.exec(`INSERT INTO bitemporal_facts (id, record_id, table_name, patch, transaction_id, actor_context, application_time, system_time) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, ...rows.flat());
      }
    };
    // Rows a batched check (prefetch) found missing: the insert follows without asking again.
    const missing = new Set();
    const isMissing = key => missing.delete(key);
    const ensureEntity = id => {
      if (known.has(`entity|${id}`)) return;
      if (isMissing(`entity|${id}`) || !all('SELECT 1 AS found FROM entity WHERE id = ?', id).length) { sql.exec('INSERT INTO entity (id) VALUES (?)', id); log('entity', { id }, 'add'); }
      remember(`entity|${id}`);
    };
    const ensureEntityType = (entity_id, type) => {
      const key = `entity_types|${entity_id}|${type}`;
      if (known.has(key)) return;
      if (isMissing(key) || !all('SELECT 1 AS found FROM entity_types WHERE entity_id = ? AND type_id = ?', entity_id, type).length) {
        sql.exec('INSERT INTO entity_types (entity_id, type_id) VALUES (?, ?)', entity_id, type);
        log('entity_types', { entity_id, type_id: type }, 'add');
      }
      remember(key);
    };
    const ensureType = type => { ensureEntity(type); ensureEntity('type:type'); ensureEntityType(type, 'type:type'); };
    const ensureVocabulary = (id, ofType) => { ensureType(ofType); ensureEntity(id); ensureEntityType(id, ofType); };
    const ensureProperty = (type, property) => {
      ensureType(type);
      ensureVocabulary(property, 'type:property');
      const key = `type_properties|${type}|${property}`;
      if (known.has(key)) return;
      if (isMissing(key) || !all('SELECT 1 AS found FROM type_properties WHERE type_id = ? AND property_id = ?', type, property).length) {
        sql.exec('INSERT INTO type_properties (type_id, property_id) VALUES (?, ?)', type, property);
        log('type_properties', { type_id: type, property_id: property }, 'add');
      }
      remember(key);
    };
    // One query per table for every row a write is about to make sure of, in place of one per row: what is there is
    // remembered, what is not is inserted without a check. `wanted` is { entities: [id], types: [[entity_id, type]], properties: [[type, property]] }.
    const prefetch = ({ entities, types, properties }) => {
      const ask = (keyOf, rows, query, parse = found => found) => {
        const wanted = rows.filter(row => !known.has(keyOf(row)));
        if (!wanted.length) return;
        const present = new Set(all(query, JSON.stringify(wanted)).map(found => keyOf(parse(found.k))));
        for (const row of wanted) {
          const key = keyOf(row);
          if (present.has(key)) remember(key); else missing.add(key);
        }
      };
      // reads-ok: each looks up only the rows this write names, one indexed probe per row
      ask(id => `entity|${id}`, [...new Set(entities)],
        'SELECT e.id AS k FROM json_each(?) j JOIN entity e ON e.id = j.value');
      // reads-ok: as above
      ask(pair => `entity_types|${pair[0]}|${pair[1]}`, uniquePairs(types),
        "SELECT json_array(t.entity_id, t.type_id) AS k FROM json_each(?) j JOIN entity_types t ON t.entity_id = json_extract(j.value, '$[0]') AND t.type_id = json_extract(j.value, '$[1]')", JSON.parse);
      ask(pair => `type_properties|${pair[0]}|${pair[1]}`, uniquePairs(properties),
        "SELECT json_array(t.type_id, t.property_id) AS k FROM json_each(?) j JOIN type_properties t ON t.type_id = json_extract(j.value, '$[0]') AND t.property_id = json_extract(j.value, '$[1]')", JSON.parse);
    };
    for (const type of BOOT_TYPES) ensureType(type);
    return { log, ensureEntity, ensureEntityType, ensureType, ensureVocabulary, ensureProperty, prefetch, flush };
  }

  const inRange = column => `(${column} = ? OR (${column} >= ? AND ${column} < ?))`;
  const rootType = id => all('SELECT type_id FROM entity_types WHERE entity_id = ? AND type_id != ? LIMIT 1', id, 'type:type')[0]?.type_id.slice('type:'.length) ?? null;
  const scoped = (column, rootId, omit = [], kind = null) => {
    const clauses = [inRange(column)];
    const params = [rootId, ...rangeOf(rootId)];
    for (const field of omit) {
      const child = `${rootId}/${segment(field)}`;
      clauses.push(`NOT ${inRange(column)} AND ${column} != ?`);
      params.push(child, ...rangeOf(child), `${child}#part`);
    }
    if (omit.length && kind === 'facts' && rootType(rootId)) {
      clauses.push(`NOT (${column} = ? AND property_id IN (${omit.map(() => '?').join(', ')}))`);
      params.push(rootId, ...omit.map(field => propertyId(rootType(rootId), field)));
    }
    if (omit.length && kind === 'parts') {
      clauses.push(`NOT (${column} = ? AND role_id IN (${omit.map(() => '?').join(', ')}))`);
      params.push(rootId, ...omit.map(roleId));
    }
    return { clause: clauses.join(' AND '), params };
  };
  // What one record holds, counted by SQLite over its id range without reading a row into memory.
  function sizeOf(rootId, omit = []) {
    const entities = scoped('id', rootId, omit);
    const facts = scoped('subject_id', rootId, omit, 'facts');
    const parts = scoped('interaction_id', rootId, omit, 'parts');
    const members = scoped('set_id', rootId, omit);
    const [counted] = all(`SELECT (SELECT COUNT(*) FROM entity WHERE ${entities.clause}) AS entities,
      (SELECT COUNT(*) FROM attribute_fact WHERE ${facts.clause}) AS facts,
      (SELECT COALESCE(SUM(length(value_json)), 0) FROM attribute_fact WHERE ${facts.clause}) AS bytes,
      (SELECT COUNT(*) FROM participation WHERE ${parts.clause}) AS parts,
      (SELECT COUNT(*) FROM interaction_set_members WHERE ${members.clause}) AS members`,
      ...entities.params, ...facts.params, ...facts.params, ...parts.params, ...members.params);
    return { rows: counted.entities + counted.facts + counted.parts + counted.members, bytes: counted.bytes, ...counted };
  }
  // Refuses a record past the bounds, naming the top-level fields it grew under (only when refusing, so a normal
  // read pays one counting query).
  function withinBounds(rootId, omit = []) {
    const size = sizeOf(rootId, omit);
    if (size.rows <= bounds.rows && size.bytes <= bounds.bytes) return size;
    const factScope = scoped('subject_id', rootId, omit, 'facts');
    const from = rootId.length + 2;
    size.by_field = all(`SELECT CASE WHEN subject_id = ? THEN substr(property_id, length(?) + 1)
      ELSE substr(subject_id, ?, instr(substr(subject_id, ?) || '/', '/') - 1) END AS field,
      COUNT(*) AS values_held, COALESCE(SUM(length(value_json)), 0) AS bytes
      FROM attribute_fact WHERE ${factScope.clause} GROUP BY field ORDER BY values_held DESC LIMIT 20`,
      rootId, `prop:${rootType(rootId)}:`, from, from, ...factScope.params);
    throw new RecordTooLarge(rootId, size);
  }

  // Everything one record holds now, found by its id range. The rows already needed to assemble the record also
  // establish its size. Count them as they arrive instead of scanning every table first with sizeOf(). Each query is
  // capped before a host that materializes its cursor can allocate more than one record's allowed rows; a single
  // oversized value is never returned by SQLite. Only a record that crosses a bound pays the exact sizeOf() scan
  // for its refusal details.
  function current(rootId, omit = [], remaining = null) {
    const entityScope = scoped('e.id', rootId, omit);
    const factScope = scoped('subject_id', rootId, omit, 'facts');
    const partScope = scoped('interaction_id', rootId, omit, 'parts');
    const setScope = scoped('set_id', rootId, omit);
    const admitted = remaining ?? bounds;
    const rowLimit = admitted.rows + 1;
    const size = { entities: 0, facts: 0, parts: 0, members: 0, bytes: 0, rows: 0 };
    let exactSize = null;
    const count = (kind, bytes = 0) => {
      size[kind] += 1;
      size.rows += 1;
      size.bytes += bytes;
      if (size.rows > admitted.rows || size.bytes > admitted.bytes) {
        if (remaining) throw new RecordTooLarge(rootId, size);
        withinBounds(rootId, omit);
      }
    };
    const entities = new Map();
    const seenEntities = new Set();
    let entityRows = 0;
    for (const row of sql.exec(`SELECT e.id AS id, t.type_id AS type_id FROM entity e LEFT JOIN entity_types t ON t.entity_id = e.id WHERE ${entityScope.clause} LIMIT ${rowLimit}`, ...entityScope.params)) {
      entityRows += 1;
      if (!seenEntities.has(row.id)) { seenEntities.add(row.id); count('entities'); }
      if (row.id.endsWith('#part')) continue;
      entities.set(row.id, row.type_id ? row.type_id.slice('type:'.length) : null);
    }
    // An entity with several types can make the join hit the cap before the record itself does. Recheck the exact
    // entity count in that unusual case, then page the complete join in primary-key order. Every cursor still has
    // a row cap; ordinary one-type records never pay the extra queries.
    if (entityRows === rowLimit) {
      exactSize = withinBounds(rootId, omit);
      if (remaining && (exactSize.rows > admitted.rows || exactSize.bytes > admitted.bytes)) throw new RecordTooLarge(rootId, exactSize);
      entities.clear();
      for (let offset = 0; ; offset += rowLimit) {
        const page = all(`SELECT e.id AS id, t.type_id AS type_id FROM entity e LEFT JOIN entity_types t ON t.entity_id = e.id WHERE ${entityScope.clause} ORDER BY e.id, t.type_id LIMIT ${rowLimit} OFFSET ?`, ...entityScope.params, offset);
        for (const row of page) if (!row.id.endsWith('#part')) entities.set(row.id, row.type_id ? row.type_id.slice('type:'.length) : null);
        if (page.length < rowLimit) break;
      }
    }
    const facts = new Map();
    for (const row of sql.exec(`SELECT subject_id, property_id, type_id, CASE WHEN length(value_json) <= ? THEN value_json ELSE NULL END AS value_json, length(value_json) AS value_chars FROM attribute_fact WHERE ${factScope.clause} LIMIT ${rowLimit}`, admitted.bytes, ...factScope.params)) {
      count('facts', Number(row.value_chars ?? 0));
      facts.set(`${row.subject_id}\u0000${row.property_id}`, { subject_id: row.subject_id, property_id: row.property_id, type_id: row.type_id, value_json: row.value_json });
    }
    const parts = new Map();
    for (const row of sql.exec(`SELECT id, interaction_id, participant_id, role_id FROM participation WHERE ${partScope.clause} LIMIT ${rowLimit}`, ...partScope.params)) {
      count('parts');
      parts.set(row.id, { interaction_id: row.interaction_id, participant_id: row.participant_id, role_id: row.role_id });
    }
    const sets = new Map();
    for (const row of sql.exec(`SELECT set_id, member_id, ordinal FROM interaction_set_members WHERE ${setScope.clause} ORDER BY ordinal LIMIT ${rowLimit}`, ...setScope.params)) {
      count('members');
      if (!sets.has(row.set_id)) sets.set(row.set_id, []);
      sets.get(row.set_id).push(row.member_id);
    }
    return { entities, facts, parts, sets, size: exactSize ?? size };
  }

  // Many records at once: the rows of up to READ_MANY roots found by four statements (one per table) over their id
  // ranges, where current() finds one root's with four. Each root is counted against the bounds as its rows arrive, as
  // current() counts. A root that crosses a bound, holds a value past READ_MANY_VALUE_BYTES or an entity of several
  // types is left out of the answer, and so is the whole batch when its rows together pass the bounds; the caller reads
  // those one at a time with current(), so it meets exactly what a single read meets.
  function currentMany(rootIds) {
    const ranges = JSON.stringify(rootIds.map(id => [id, ...rangeOf(id)]));
    const among = (select, table, column, join = '', order = '') => `WITH roots(root, lo, hi) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))
      SELECT roots.root AS root, ${select} FROM roots JOIN ${table} ON ${column} = roots.root ${join}
      UNION ALL SELECT roots.root AS root, ${select} FROM roots JOIN ${table} ON ${column} >= roots.lo AND ${column} < roots.hi ${join} ${order} LIMIT ${bounds.rows + 1}`;
    const found = new Map(rootIds.map(id => [id, { entities: new Map(), facts: new Map(), parts: new Map(), sets: new Map(), size: { entities: 0, facts: 0, parts: 0, members: 0, bytes: 0, rows: 0 } }]));
    const leftOut = new Set();
    let rows = 0;
    let bytes = 0;
    // False when the batch together passes the bounds.
    const count = (root, kind, size = 0) => {
      rows += 1;
      bytes += size;
      if (rows > bounds.rows || bytes > bounds.bytes) return false;
      const held = found.get(root).size;
      held[kind] += 1;
      held.rows += 1;
      held.bytes += size;
      if (held.rows > bounds.rows || held.bytes > bounds.bytes) leftOut.add(root);
      return true;
    };
    const seen = new Set();
    for (const row of sql.exec(among('e.id AS id, t.type_id AS type_id', 'entity e', 'e.id', 'LEFT JOIN entity_types t ON t.entity_id = e.id'), ranges)) {
      if (seen.has(row.id)) { leftOut.add(row.root); continue; }
      seen.add(row.id);
      if (!count(row.root, 'entities')) return null;
      if (!row.id.endsWith('#part')) found.get(row.root).entities.set(row.id, row.type_id ? row.type_id.slice('type:'.length) : null);
    }
    for (const row of sql.exec(among('f.subject_id AS subject_id, f.property_id AS property_id, f.type_id AS type_id, CASE WHEN length(f.value_json) <= ? THEN f.value_json ELSE NULL END AS value_json, length(f.value_json) AS value_chars', 'attribute_fact f', 'f.subject_id'), ranges, READ_MANY_VALUE_BYTES, READ_MANY_VALUE_BYTES)) {
      if (row.value_json === null) leftOut.add(row.root);
      if (!count(row.root, 'facts', Number(row.value_chars ?? 0))) return null;
      found.get(row.root).facts.set(`${row.subject_id}\u0000${row.property_id}`, { subject_id: row.subject_id, property_id: row.property_id, type_id: row.type_id, value_json: row.value_json });
    }
    for (const row of sql.exec(among('p.id AS id, p.interaction_id AS interaction_id, p.participant_id AS participant_id, p.role_id AS role_id', 'participation p', 'p.interaction_id'), ranges)) {
      if (!count(row.root, 'parts')) return null;
      found.get(row.root).parts.set(row.id, { interaction_id: row.interaction_id, participant_id: row.participant_id, role_id: row.role_id });
    }
    for (const row of sql.exec(among('m.set_id AS set_id, m.member_id AS member_id, m.ordinal AS ordinal', 'interaction_set_members m', 'm.set_id', '', 'ORDER BY ordinal'), ranges)) {
      if (!count(row.root, 'members')) return null;
      const sets = found.get(row.root).sets;
      if (!sets.has(row.set_id)) sets.set(row.set_id, []);
      sets.get(row.set_id).push(row.member_id);
    }
    for (const root of leftOut) found.delete(root);
    return found;
  }

  const noRows = () => ({ entities: new Map(), facts: new Map(), parts: new Map(), sets: new Map(), size: { rows: 0, bytes: 0 } });
  // Keeps the rows a whole write left a root record with: the rows it was written as, or null when it was removed. One
  // past the bounds is not kept, so reading it refuses as a read from the database would (counted as sizeOf counts:
  // every link is also an entity row).
  function keepWritten(id, desired) {
    if (desired === null) return records.keep(id, null, 0);
    let bytes = 0;
    for (const fact of desired.facts.values()) bytes += fact.value_json.length;
    let members = 0;
    for (const list of desired.sets.values()) members += list.length;
    if (desired.entities.size + 2 * desired.parts.size + desired.facts.size + members > bounds.rows || bytes > bounds.bytes) return;
    const rows = { entities: desired.entities, facts: desired.facts, parts: desired.parts, sets: desired.sets,
      size: { rows: desired.entities.size + 2 * desired.parts.size + desired.facts.size + members, bytes } };
    records.keep(id, rows, heldBytes(rows));
  }

  // Bring one record's rows from what they are to what they should be, logging every change.
  function apply(rootId, desired, context, { keepMissing = false, nowRows = null } = {}) {
    // A record whose rows are kept (read, or written by this store, and not changed since) is not read again to find
    // what it holds; one known absent holds no rows.
    const now = nowRows ?? (records.absent(rootId) ? noRows() : records.get(rootId) ?? current(rootId));
    // Every row written here sits under one root record (its id up to the first '/'), which is read again next time.
    records.forget(rootId.split('/')[0]);
    const w = writer(context);
    const typed = [...desired.entities].map(([id, typeName]) => [id, typeId(typeName)]);
    w.prefetch({
      entities: [...typed.flatMap(([id, type]) => [id, type]), ...[...desired.parts.keys()], ...[...desired.parts.values()].map(part => part.role_id),
        ...[...desired.facts.values()].flatMap(fact => [fact.type_id, fact.property_id]), 'type:type'],
      types: [...typed, ...typed.map(([, type]) => [type, 'type:type']), ...[...desired.parts.values()].flatMap(part => [[part.role_id, 'type:role']]),
        ...[...desired.parts.keys()].map(id => [id, 'type:participation']),
        ...[...desired.facts.values()].flatMap(fact => [[fact.type_id, 'type:type'], [fact.property_id, 'type:property']])],
      properties: [...desired.facts.values()].map(fact => [fact.type_id, fact.property_id]),
    });
    // Shared children first: they are immutable, so an existing one is never written again.
    for (const [id, { typeName, value }] of desired.shared) {
      if (!all('SELECT 1 AS found FROM entity WHERE id = ?', id).length) apply(id, decompose(id, typeName, value, contentId), context, { keepMissing: true });
    }
    for (const [id, typeName] of desired.entities) {
      w.ensureEntity(id);
      if (now.entities.get(id) !== typeName) {
        w.ensureType(typeId(typeName));
        w.ensureEntityType(id, typeId(typeName));
        if (now.entities.has(id) && now.entities.get(id) !== null) {
          sql.exec('DELETE FROM entity_types WHERE entity_id = ? AND type_id = ?', id, typeId(now.entities.get(id)));
          known.delete(`entity_types|${id}|${typeId(now.entities.get(id))}`);
          w.log('entity_types', { entity_id: id, type_id: typeId(now.entities.get(id)) }, 'remove');
        }
      }
    }
    for (const [setId, members] of desired.sets) {
      const before = now.sets.get(setId) ?? [];
      const membersHash = hash(JSON.stringify([setId, members]));
      if (!now.sets.has(setId) && !all('SELECT 1 AS found FROM interaction_sets WHERE id = ?', setId).length) {
        sql.exec('INSERT INTO interaction_sets (id, members_hash) VALUES (?, ?)', setId, membersHash);
        w.log('interaction_sets', { id: setId }, 'add', { members_hash: membersHash });
      } else if (JSON.stringify(before) !== JSON.stringify(members)) {
        sql.exec('UPDATE interaction_sets SET members_hash = ? WHERE id = ?', membersHash, setId);
        w.log('interaction_sets', { id: setId }, 'replace', { members_hash: membersHash });
      }
      members.forEach((member, ordinal) => {
        if (before[ordinal] === member) return;
        if (before.includes(member)) {
          sql.exec('UPDATE interaction_set_members SET ordinal = ? WHERE set_id = ? AND member_id = ?', ordinal, setId, member);
          w.log('interaction_set_members', { set_id: setId, member_id: member }, 'replace', { ordinal });
        } else {
          sql.exec('INSERT INTO interaction_set_members (set_id, member_id, ordinal) VALUES (?, ?, ?)', setId, member, ordinal);
          w.log('interaction_set_members', { set_id: setId, member_id: member }, 'add', { ordinal });
        }
      });
    }
    for (const [key, fact] of desired.facts) {
      if (now.facts.get(key)?.value_json === fact.value_json) continue;
      w.ensureProperty(fact.type_id, fact.property_id);
      sql.exec('INSERT INTO attribute_fact (subject_id, property_id, type_id, value_json) VALUES (?, ?, ?, ?) ON CONFLICT (subject_id, property_id, type_id) DO UPDATE SET value_json = excluded.value_json', fact.subject_id, fact.property_id, fact.type_id, fact.value_json);
      w.log('attribute_fact', fact, now.facts.has(key) ? 'replace' : 'add', JSON.parse(fact.value_json));
    }
    for (const [id, part] of desired.parts) {
      const before = now.parts.get(id);
      if (before?.participant_id === part.participant_id && before.role_id === part.role_id) continue;
      w.ensureEntity(id);
      w.ensureEntityType(id, 'type:participation');
      w.ensureVocabulary(part.role_id, 'type:role');
      sql.exec('INSERT INTO participation (id, interaction_id, participant_id, role_id, counterpart_id) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET participant_id = excluded.participant_id, role_id = excluded.role_id', id, part.interaction_id, part.participant_id, part.role_id);
      w.log('participation', { id }, before ? 'replace' : 'add', part);
    }
    if (keepMissing) return w.flush();
    // Removals, in the order the foreign keys allow: members, links, values, types, sets, entities.
    for (const [setId, members] of now.sets) {
      const keep = new Set(desired.sets.get(setId) ?? []);
      for (const member of members) if (!keep.has(member)) {
        sql.exec('DELETE FROM interaction_set_members WHERE set_id = ? AND member_id = ?', setId, member);
        w.log('interaction_set_members', { set_id: setId, member_id: member }, 'remove');
      }
    }
    for (const [id] of now.parts) if (!desired.parts.has(id)) {
      sql.exec('DELETE FROM participation WHERE id = ?', id);
      w.log('participation', { id }, 'remove');
      sql.exec('DELETE FROM entity_types WHERE entity_id = ?', id);
      sql.exec('DELETE FROM entity WHERE id = ?', id);
      known.delete(`entity|${id}`);
      known.delete(`entity_types|${id}|type:participation`);
      w.log('entity', { id }, 'remove');
    }
    for (const [key, fact] of now.facts) if (!desired.facts.has(key)) {
      sql.exec('DELETE FROM attribute_fact WHERE subject_id = ? AND property_id = ? AND type_id = ?', fact.subject_id, fact.property_id, fact.type_id);
      w.log('attribute_fact', fact, 'remove');
    }
    for (const [id, typeName] of now.entities) if (!desired.entities.has(id)) {
      if (typeName !== null) {
        sql.exec('DELETE FROM entity_types WHERE entity_id = ?', id);
        known.delete(`entity_types|${id}|${typeId(typeName)}`);
        w.log('entity_types', { entity_id: id, type_id: typeId(typeName) }, 'remove');
      }
      if (now.sets.has(id) || all('SELECT 1 AS found FROM interaction_sets WHERE id = ?', id).length) {
        sql.exec('DELETE FROM interaction_sets WHERE id = ?', id);
        w.log('interaction_sets', { id }, 'remove');
      }
      sql.exec('DELETE FROM entity WHERE id = ?', id);
      known.delete(`entity|${id}`);
      w.log('entity', { id }, 'remove');
    }
    w.flush();
  }

  const sharedCache = new Map();
  let sharedBytes = 0;
  const forgetShared = id => {
    const held = sharedCache.get(id);
    if (!held) return;
    sharedBytes -= held.bytes;
    sharedCache.delete(id);
  };
  function keepShared(id, value, size) {
    forgetShared(id);
    if (size.bytes > sharedCacheBytes || size.bytes > sharedExpansionBytes) return;
    while (sharedCache.size >= SHARED_KEPT || sharedBytes + size.bytes > sharedCacheBytes) {
      forgetShared(sharedCache.keys().next().value);
    }
    sharedCache.set(id, { value, bytes: size.bytes, rows: size.rows });
    sharedBytes += size.bytes;
  }
  function chargeExpansion(id, size, expansion) {
    const bytes = expansion.bytes + size.bytes;
    if (bytes > sharedExpansionBytes) throw new RecordTooLarge(id, { rows: size.rows, bytes });
    expansion.bytes = bytes;
  }
  // Shared objects being assembled right now: one that names itself, however far down, is refused rather than read forever.
  const opening = new Set();
  function assemble(rootId, rows, expansion = { bytes: 0 }) {
    const objects = new Map();
    for (const [id, typeName] of rows.entities) if (typeName !== 'set') objects.set(id, {});
    // Bound the object shells and list containers before populating them. The SQLite row limit bounds this loop too.
    let shells = objects.size * 64;
    for (const members of rows.sets.values()) shells += 32 + members.length * 8;
    chargeExpansion(rootId, { rows: objects.size + rows.sets.size, bytes: shells }, expansion);
    for (const fact of rows.facts.values()) {
      const target = objects.get(fact.subject_id);
      if (!target) continue;
      const prefix = `prop:${fact.type_id.slice('type:'.length)}:`;
      const field = fact.property_id.slice(prefix.length);
      const size = jsonExpansionBytes(fact.value_json, sharedExpansionBytes - expansion.bytes);
      size.bytes += OBJECT_PROPERTY_BYTES + field.length * 2;
      size.rows += 1;
      // Reserve the expanded footprint before JSON.parse allocates arrays, strings and object properties.
      chargeExpansion(rootId, size, expansion);
      const value = JSON.parse(fact.value_json);
      target[field] = value;
    }
    const valueOf = id => {
      if (rows.sets.has(id)) return rows.sets.get(id).map(member => objects.get(member));
      if (objects.has(id)) return objects.get(id);
      return readShared(id, expansion);
    };
    for (const part of rows.parts.values()) {
      const target = objects.get(part.interaction_id);
      if (target) {
        const field = part.role_id.slice('role:'.length);
        chargeExpansion(rootId, { rows: 1, bytes: OBJECT_PROPERTY_BYTES + field.length * 2 }, expansion);
        target[field] = valueOf(part.participant_id);
      }
    }
    return objects.get(rootId) ?? null;
  }
  function readShared(id, expansion) {
    let held = sharedCache.get(id);
    if (held) {
      // Reads refresh the LRU position. The cache owns its graph; callers always get an isolated clone.
      sharedCache.delete(id);
      sharedCache.set(id, held);
    } else {
      if (opening.has(id)) throw new Error(`Record ${id} contains itself.`);
      opening.add(id);
      try {
        const rows = current(id);
        // Preflight cold nested facts against the caller's remaining budget before parsing them. Keep the construction
        // meter separate so the completed child is charged exactly once to the caller, as it is on a warm cache read.
        const value = assemble(id, rows, { bytes: expansion.bytes });
        const size = assembledBytes(value);
        if (size.bytes > sharedExpansionBytes) throw new RecordTooLarge(id, size);
        // An item too large for the cache briefly exists beside its returned clone; charge both copies. Cacheable
        // entries are covered by the aggregate resident budget, while every read pays only for its returned clone.
        chargeExpansion(id, size.bytes > sharedCacheBytes ? { ...size, bytes: 2 * size.bytes } : size, expansion);
        keepShared(id, value, size);
        held = { value, bytes: size.bytes, rows: size.rows };
      } finally { opening.delete(id); }
      return structuredClone(held.value);
    }
    chargeExpansion(id, held, expansion);
    return structuredClone(held.value);
  }

  // What this store remembers of the database (rows it made sure of, shared objects it read) is true only of committed
  // rows. A transaction that rolls back takes rows away the memory still names, and the next write that trusts it
  // fails a foreign key; so a rolled-back write forgets it all, and a host whose own outer transaction rolls back after
  // a write here calls forgetCached().
  let sealedLogNames = null;
  const forgetCached = () => { known.clear(); sharedCache.clear(); sharedBytes = 0; records.clear(); sealedLogNames = null; };

  const listId = (id, field) => `${id}/${segment(field)}`;
  const listMembers = (id, field) => all('SELECT member_id, ordinal FROM interaction_set_members WHERE set_id = ? ORDER BY ordinal', listId(id, field));
  const memberType = (id, field) => `${rootType(id)}/${field}`;
  const memberProperty = (id, field, name) => propertyId(memberType(id, field), name);
  const countMembers = (id, field) => all('SELECT COUNT(*) AS n FROM interaction_set_members WHERE set_id = ?', listId(id, field))[0].n;

  // These list operations leave every sibling member untouched. A long decision can add one answer or call without
  // reading the answers and calls it already holds; the same operations work for any root type and object-list field.
  const sealedLogs = () => [...(sealedLogNames ??= all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ? ORDER BY name", `${SEALED_LOG}*`).map(row => row.name))];
  const oldestLogId = () => all(`SELECT id FROM ${LOG_TABLE} ORDER BY rowid LIMIT 1`)[0]?.id ?? null;

  const validateMemberFields = (names, ordinals) => {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new Error('names must be field names');
    if (ordinals !== null && (!Array.isArray(ordinals) || ordinals.some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('ordinals must be nonnegative integers');
  };
  // Both entry points keep the same exact attribute projection and point-query cost.
  const projectMemberFields = (id, field, names, ordinals) => {
    const propertyNames = names.map(name => memberProperty(id, field, name));
    const rows = all(`SELECT m.ordinal, a.property_id, a.value_json FROM interaction_set_members m
      JOIN attribute_fact a ON a.subject_id = m.member_id
      WHERE m.set_id = ? AND a.property_id IN (SELECT value FROM json_each(?))${ordinals ? ' AND m.ordinal IN (SELECT value FROM json_each(?))' : ''}
      ORDER BY m.ordinal`, listId(id, field), JSON.stringify(propertyNames), ...(ordinals ? [JSON.stringify(ordinals)] : []));
    const byOrdinal = new Map();
    for (const row of rows) {
      const value = byOrdinal.get(row.ordinal) ?? { ordinal: row.ordinal };
      value[names[propertyNames.indexOf(row.property_id)]] = JSON.parse(row.value_json);
      byOrdinal.set(row.ordinal, value);
    }
    return [...byOrdinal.values()];
  };

  const listOps = {
    // A positive selected-field read never walks unrequested field ranges. Use existing bounded subtree
    // assembly for each requested participant and the same total row/byte guard for the combined result.
    readSelected(id, names = []) {
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new Error('Selected fields must name fields');
      const type = rootType(id);
      if (!type) return null;
      const selected = [...new Set(names)], rowLimit = bounds.rows + 1;
      const rows = { entities: new Map([[id,type]]), facts: new Map(), parts: new Map(), sets: new Map() };
      let count = 1, bytes = 0;
      const charge = (n, b = 0) => {
        count += n; bytes += b;
        if (count > bounds.rows || bytes > bounds.bytes) throw new RecordTooLarge(id,{rows:count,bytes});
      };
      if (!selected.length) return {};
      // Admit scalar sizes before fetching their text; several individually legal fields must not
      // allocate an over-budget aggregate before the root guard fires.
      const facts = sql.exec(`SELECT f.subject_id, f.property_id, f.type_id, length(f.value_json) value_chars
        FROM json_each(?) requested CROSS JOIN attribute_fact f INDEXED BY sqlite_autoindex_attribute_fact_1
        WHERE f.subject_id = ? AND f.property_id = requested.value LIMIT ${rowLimit}`,
        JSON.stringify(selected.map(name=>propertyId(type,name))), id);
      for (const row of facts) {
        charge(1,Number(row.value_chars??0));
        const [body] = all('SELECT value_json FROM attribute_fact WHERE subject_id = ? AND property_id = ? AND type_id = ? LIMIT 1',row.subject_id,row.property_id,row.type_id);
        rows.facts.set(`${row.subject_id}\u0000${row.property_id}`,{...row,value_json:body.value_json});
      }
      // A writer gives each root/field link one exact #part identity. Seek those keys, never a role range.
      const parts = sql.exec(`SELECT p.id, p.interaction_id, p.participant_id, p.role_id
        FROM json_each(?) requested CROSS JOIN participation p INDEXED BY sqlite_autoindex_participation_1
        WHERE p.id = requested.value AND p.interaction_id = ? LIMIT ${rowLimit}`,
        JSON.stringify(selected.map(name=>partId(id,name))),id);
      const opened = new Set();
      for (const row of parts) {
        charge(1); rows.parts.set(row.id,row);
        // Shared children stay external, so normal assembly applies its clone/cycle/expansion owner.
        if (!row.participant_id.startsWith(`${id}/`) || opened.has(row.participant_id)) continue;
        opened.add(row.participant_id);
        const child = current(row.participant_id,[],{rows:bounds.rows-count,bytes:bounds.bytes-bytes});
        charge(child.size.rows,child.size.bytes);
        for (const kind of ['entities','facts','parts','sets']) for (const [key,value] of child[kind]) rows[kind].set(key,value);
      }
      return assemble(id,rows);
    },
    readOwn(id, omit = []) {
      if (!Array.isArray(omit) || omit.some(field => typeof field !== 'string' || !field)) throw new Error('omit must name fields');
      const rows = current(id, omit);
      return rows.entities.has(id) ? assemble(id, rows) : null;
    },
    ownFieldPresent(id, field) {
      const type = rootType(id);
      if (!type) return false;
      return Boolean(all('SELECT 1 AS found FROM attribute_fact WHERE subject_id = ? AND property_id = ? LIMIT 1', id, propertyId(type, field)).length
        || all('SELECT 1 AS found FROM participation WHERE interaction_id = ? AND role_id = ? LIMIT 1', id, roleId(field)).length);
    },
    memberCount: countMembers,
    readMember(id, field, ordinal) {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Member ordinal must be a nonnegative integer.');
      const matches = all('SELECT member_id FROM interaction_set_members WHERE set_id = ? AND ordinal = ?', listId(id, field), ordinal);
      if (matches.length > 1) throw new Error(`List ${id}/${field} has more than one member at ${ordinal}.`);
      if (!matches.length) return null;
      const rows = current(matches[0].member_id);
      return rows.entities.has(matches[0].member_id) ? assemble(matches[0].member_id, rows) : null;
    },
    memberFields(id, field, names, ordinals = null) {
      validateMemberFields(names, ordinals);
      if (!names.length || (ordinals && !ordinals.length)) return [];
      return projectMemberFields(id, field, names, ordinals);
    },
    memberFieldsMany(ids, field, names, ordinals = null) {
      validateMemberFields(names, ordinals);
      const unique = [...new Set(ids)];
      if (!names.length || (ordinals && !ordinals.length)) return new Map(unique.map(id => [id, []]));
      return new Map(unique.map(id => [id, projectMemberFields(id, field, names, ordinals)]));
    },
    membersHolding(id, field, name) {
      const property = memberProperty(id, field, name);
      return all(`SELECT m.ordinal FROM interaction_set_members m WHERE m.set_id = ? AND (
        EXISTS (SELECT 1 FROM attribute_fact a WHERE a.subject_id = m.member_id AND a.property_id = ?)
        OR EXISTS (SELECT 1 FROM participation p WHERE p.interaction_id = m.member_id AND p.role_id = ?)) ORDER BY m.ordinal`,
      listId(id, field), property, roleId(name)).map(row => row.ordinal);
    },
    membersWhere(id, field, name, value) {
      return all(`SELECT m.ordinal FROM interaction_set_members m JOIN attribute_fact a ON a.subject_id = m.member_id
        WHERE m.set_id = ? AND a.property_id = ? AND a.value_json = ? ORDER BY m.ordinal`,
      listId(id, field), memberProperty(id, field, name), JSON.stringify(value)).map(row => row.ordinal);
    },
    writeOwn(id, type, value, omit = [], { actor = {}, application_time, transaction_id = uuidv7() } = {}) {
      if (!isObject(value) || !Array.isArray(omit) || omit.some(field => typeof field !== 'string' || !field)) throw new Error('writeOwn needs an object and fields to leave in place.');
      if (rootType(id) !== type) throw new Error(`Record ${id} is not a ${type}.`);
      const system_time = new Date().toISOString();
      const context = { actor, application_time: application_time ?? system_time, system_time, transaction_id };
      const own = Object.fromEntries(Object.entries(value).filter(([field]) => !omit.includes(field)));
      const desired = decompose(id, type, own, contentId);
      desired.entities.set(id, type);
      try { transaction(() => apply(id, desired, context, { nowRows: current(id, omit) })); }
      catch (error) { forgetCached(); throw error; }
      return { transaction_id };
    },
    writeMember(id, type, field, ordinal, value, { actor = {}, application_time, transaction_id = uuidv7() } = {}) {
      if (rootType(id) !== type) throw new Error(`Record ${id} is not a ${type}.`);
      if (!isObject(value) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('writeMember needs an object and a nonnegative ordinal.');
      const setId = listId(id, field);
      const memberId = `${setId}/${ordinal}`;
      records.forget(id);
      const system_time = new Date().toISOString();
      const context = { actor, application_time: application_time ?? system_time, system_time, transaction_id };
      try { transaction(() => {
        const count = countMembers(id, field);
        if (ordinal > count) throw new Error(`List ${id}/${field} cannot skip ordinal ${count}.`);
        const existing = ordinal < count ? all('SELECT member_id FROM interaction_set_members WHERE set_id = ? AND ordinal = ?', setId, ordinal) : [];
        if (ordinal < count && (existing.length !== 1 || existing[0].member_id !== memberId)) throw new Error(`List ${id}/${field} has an inconsistent member at ${ordinal}.`);
        const oldFact = all('SELECT subject_id, property_id, type_id, value_json FROM attribute_fact WHERE subject_id = ? AND property_id = ?', id, propertyId(type, field))[0];
        const part = partId(id, field);
        const oldPart = all('SELECT participant_id, role_id FROM participation WHERE id = ?', part)[0];
        if (oldFact && (oldFact.value_json !== '[]' || oldPart)) throw new Error(`Field ${id}/${field} is not an empty list.`);
        if (oldPart && (oldPart.participant_id !== setId || oldPart.role_id !== roleId(field) || !all('SELECT 1 AS found FROM interaction_sets WHERE id = ?', setId).length)) throw new Error(`Field ${id}/${field} is not this list.`);
        if (count && !oldPart) throw new Error(`List ${id}/${field} has no field link.`);
        const desired = decompose(memberId, `${type}/${field}`, value, contentId);
        desired.entities.set(memberId, `${type}/${field}`);
        apply(memberId, desired, context);
        if (ordinal < count) return;
        const w = writer(context);
        w.ensureEntity(setId);
        w.ensureType(typeId('set'));
        w.ensureEntityType(setId, typeId('set'));
        if (oldFact) {
          sql.exec('DELETE FROM attribute_fact WHERE subject_id = ? AND property_id = ? AND type_id = ?', oldFact.subject_id, oldFact.property_id, oldFact.type_id);
          w.log('attribute_fact', oldFact, 'remove');
        }
        w.ensureEntity(part);
        w.ensureEntityType(part, 'type:participation');
        w.ensureVocabulary(roleId(field), 'type:role');
        sql.exec('INSERT INTO participation (id, interaction_id, participant_id, role_id, counterpart_id) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET participant_id = excluded.participant_id, role_id = excluded.role_id', part, id, setId, roleId(field));
        if (oldPart?.participant_id !== setId || oldPart.role_id !== roleId(field)) w.log('participation', { id: part }, oldPart ? 'replace' : 'add', { interaction_id: id, participant_id: setId, role_id: roleId(field) });
        // The stored hash names the complete ordered membership. Appending reads only member IDs, never payloads.
        const members = [...listMembers(id, field).map(row => row.member_id), memberId];
        const membersHash = hash(JSON.stringify([setId, members]));
        if (count) {
          sql.exec('UPDATE interaction_sets SET members_hash = ? WHERE id = ?', membersHash, setId);
          w.log('interaction_sets', { id: setId }, 'replace', { members_hash: membersHash });
        } else {
          sql.exec('INSERT INTO interaction_sets (id, members_hash) VALUES (?, ?)', setId, membersHash);
          w.log('interaction_sets', { id: setId }, 'add', { members_hash: membersHash });
        }
        sql.exec('INSERT INTO interaction_set_members (set_id, member_id, ordinal) VALUES (?, ?, ?)', setId, memberId, ordinal);
        w.log('interaction_set_members', { set_id: setId, member_id: memberId }, 'add', { ordinal });
        w.flush();
      }); } catch (error) { forgetCached(); throw error; }
      return { transaction_id };
    },
  };

  return {
    ...listOps,
    forgetCached,
    /** Keep dependent record batches together; rebuild projections if the host rolls back. */
    atomically(work) {
      try { return transaction(work); }
      catch (error) { try { forgetCached(); } catch { /* preserve the original failure */ } throw error; }
    },
    /** How much this store holds in memory now: made-sure-of rows and assembled shared objects. */
    held: () => ({ known: known.size, shared: sharedCache.size, shared_bytes: sharedBytes, records: records.size() }),
    /** Write whole root records: [{ id, type, value }], value null to remove. One transaction, one log transaction id. */
    write(records, { actor = {}, application_time, transaction_id = uuidv7() } = {}) {
      const system_time = new Date().toISOString();
      try { transaction(() => {
        for (const { id, type, value } of records) {
          if (typeof id !== 'string' || !id || id.includes('/')) throw new Error(`A record id must be text without "/": ${id}`);
          const desired = value === null ? { entities: new Map(), facts: new Map(), parts: new Map(), sets: new Map(), shared: new Map() } : decompose(id, type, value, contentId);
          if (value !== null) {
            // The root's own type row is written even when the value has no fields.
            desired.entities.set(id, type);
          }
          apply(id, desired, { actor, application_time: application_time ?? system_time, system_time, transaction_id });
          // What the record holds now is exactly what was written (apply removed every other row it had), so the next
          // read or write of it needs no query to find it.
          keepWritten(id, value === null ? null : desired);
        }
      }); } catch (error) { forgetCached(); throw error; }
      return { transaction_id };
    },
    /** One root record as JSON, or null. An unchanged record read or written before is assembled from its kept rows,
     *  a fresh copy each time, with no query. */
    read(id) {
      const kept = records.get(id);
      if (kept === null) return null;
      if (kept) return kept.entities.has(id) ? assemble(id, kept) : null;
      const rows = current(id);
      records.keep(id, rows.entities.has(id) ? rows : null, heldBytes(rows));
      return rows.entities.has(id) ? assemble(id, rows) : null;
    },
    /** Many root records as JSON: a Map of id to the record or null, the same as read(id) for each. Those not kept are
     *  read READ_MANY at a time with four statements for the batch rather than four for each. */
    readMany(ids) {
      const answered = new Map();
      const unkept = [];
      for (const id of new Set(ids)) {
        const kept = records.get(id);
        if (kept === null) answered.set(id, null);
        else if (kept) answered.set(id, kept.entities.has(id) ? assemble(id, kept) : null);
        else unkept.push(id);
      }
      for (let start = 0; start < unkept.length; start += READ_MANY) {
        const batch = unkept.slice(start, start + READ_MANY);
        const rows = batch.length > 1 ? currentMany(batch) : null;
        for (const id of batch) {
          const held = rows?.get(id) ?? current(id);
          records.keep(id, held.entities.has(id) ? held : null, heldBytes(held));
          answered.set(id, held.entities.has(id) ? assemble(id, held) : null);
        }
      }
      return answered;
    },
    /** The type of one root record, or null when there is none: its one type row, whatever the record holds. */
    typeOf(id) {
      return all('SELECT type_id FROM entity_types WHERE entity_id = ? LIMIT 1', id)[0]?.type_id.slice('type:'.length) ?? null;
    },
    /** What one record holds, counted without reading it: { rows, bytes, entities, facts, parts, members }. */
    sizeOf,
    /** Root ids of one type, optionally restricted to a literal id prefix. Without a page, ids are in ascending
     *  order; with `before` and/or `limit`, they are newest first, at most `limit`. Prefix and page reads walk the
     *  (type_id, entity_id) index rather than returning every id of the type. */
    ids(type, { before, limit, prefix } = {}) {
      if (prefix !== undefined && prefix !== '') {
        const start = String(prefix);
        const end = afterPrefix(start);
        const clauses = ['type_id = ?', 'entity_id >= ?'];
        const params = [typeId(type), start];
        if (end === null) { clauses.push('substr(entity_id, 1, length(?)) = ?'); params.push(start, start); }
        else { clauses.push('entity_id < ?'); params.push(end); }
        if (before !== undefined) { clauses.push('entity_id < ?'); params.push(String(before)); }
        const where = clauses.join(' AND ');
        if (before === undefined && limit === undefined) return all(`SELECT entity_id FROM entity_types WHERE ${where} ORDER BY entity_id`, ...params).map(row => row.entity_id);
        const page = Math.max(1, Math.floor(Number(limit) || 100));
        return all(`SELECT entity_id FROM entity_types WHERE ${where} ORDER BY entity_id DESC LIMIT ?`, ...params, page).map(row => row.entity_id);
      }
      if (before === undefined && limit === undefined) return all('SELECT entity_id FROM entity_types WHERE type_id = ? ORDER BY entity_id', typeId(type)).map(row => row.entity_id);
      const page = Math.max(1, Math.floor(Number(limit) || 100));
      return (before === undefined
        ? all('SELECT entity_id FROM entity_types WHERE type_id = ? ORDER BY entity_id DESC LIMIT ?', typeId(type), page)
        : all('SELECT entity_id FROM entity_types WHERE type_id = ? AND entity_id < ? ORDER BY entity_id DESC LIMIT ?', typeId(type), String(before), page)).map(row => row.entity_id);
    },
    /**
     * Root records of every type whose words at one of `fields` hold every one of `words`, newest first (in the order
     * each was first named; a change of its words keeps its place): [{ id, type, title }]. A field is a path of field names into the record (["input", "goal"]); the
     * first field a record holds words at is its title, so a record matched by a later field still reads by its name.
     * With no words it answers the newest named records. `leaveOut` names types never answered; `types` (optional)
     * names the only types answered. Only the named fields' own facts are read (by property index), never whole records.
     */
    find({ words = [], fields, leaveOut = [], types = null, limit = 30 } = {}) {
      if (!Array.isArray(fields) || !fields.length || !fields.every(path => Array.isArray(path) && path.length && path.every(name => typeof name === 'string' && name))) throw new Error('find needs fields: a list of field-name paths');
      const skip = new Set([...BOOT_TYPES, ...leaveOut.map(typeId)]);
      const rootTypes = all("SELECT entity_id FROM entity_types WHERE type_id = 'type:type'").map(row => row.entity_id)
        .filter(type => !type.includes('/') && !skip.has(type) && (!types || types.map(typeId).includes(type))).map(type => type.slice('type:'.length));
      // Each (type, field) pair names one property; its facts live on the root or on the child the path leads to.
      const properties = new Map();
      for (const type of rootTypes) {
        fields.forEach((path, rank) => properties.set(propertyId([type, ...path.slice(0, -1)].join('/'), path.at(-1)), { type, path, rank }));
      }
      if (!properties.size) return [];
      const terms = words.map(word => String(word).toLocaleLowerCase()).filter(Boolean);
      const page = Math.max(1, Math.min(200, Math.floor(Number(limit) || 30)));
      const facts = all(`SELECT subject_id, property_id, value_json FROM attribute_fact WHERE property_id IN (SELECT value FROM json_each(?))${terms.map(() => ' AND instr(lower(value_json), ?) > 0').join('')} ORDER BY rowid DESC LIMIT ?`,
        JSON.stringify([...properties.keys()]), ...terms, page * 4);
      const found = new Map();
      for (const fact of facts) {
        const { type, path } = properties.get(fact.property_id);
        const root = fact.subject_id.split('/')[0];
        if (fact.subject_id !== [root, ...path.slice(0, -1).map(segment)].join('/') || found.has(root)) continue;
        let said;
        try { said = JSON.parse(fact.value_json); } catch { continue; }
        if (typeof said === 'string' && said.trim()) found.set(root, { id: root, type });
        if (found.size >= page) break;
      }
      if (!found.size) return [];
      // The record's title is its first named field that holds words, read for the found records only.
      const roots = [...found.values()];
      const wanted = roots.flatMap(record => fields.map(path => [record.id, ...path.slice(0, -1).map(segment)].join('/')));
      const held = new Map();
      for (const row of all('SELECT subject_id, property_id, value_json FROM attribute_fact WHERE subject_id IN (SELECT value FROM json_each(?))', JSON.stringify([...new Set(wanted)]))) {
        const property = properties.get(row.property_id);
        if (property) held.set(`${row.subject_id.split('/')[0]}\u0000${property.rank}`, row.value_json);
      }
      return roots.map(record => {
        const rank = fields.findIndex((_, index) => {
          try { const value = JSON.parse(held.get(`${record.id}\u0000${index}`) ?? 'null'); return typeof value === 'string' && value.trim(); } catch { return false; }
        });
        return { ...record, title: JSON.parse(held.get(`${record.id}\u0000${rank}`)).replace(/\s+/g, ' ').trim() };
      });
    },
    /** The sealed log tables, oldest first. */
    sealedLogs,
    /** The id of the oldest change in the open log, or null when it is empty. */
    oldestLogId,
    /** The newest immutable change still held here, across a sealed open log. One rowid seek per visited generation,
     *  newest first: a list's write/read versions use the same history position on either record engine. */
    lastLogId() {
      const current=all(`SELECT id FROM ${LOG_TABLE} ORDER BY rowid DESC LIMIT 1`)[0]?.id;
      if(current)return current;
      for(const table of sealedLogs().reverse()){
        const kept=all(`SELECT id FROM ${table} ORDER BY rowid DESC LIMIT 1`)[0]?.id;
        if(kept)return kept;
      }
      return null;
    },
    /** Seals the open log: renames it after its first row and opens a fresh one, in one transaction. Answers the sealed
     *  table's name, or null when the log is empty. */
    sealLog() {
      const first = oldestLogId();
      if (first === null) return null;
      const name = `${SEALED_LOG}${first.replace(/[^0-9a-f]/gi, '').toLowerCase()}`;
      transaction(() => {
        sql.exec(`ALTER TABLE ${LOG_TABLE} RENAME TO ${name}`);
        sql.exec(LOG_TABLE_SQL(LOG_TABLE));
      });
      sealedLogNames = null;
      return name;
    },
    /** A sealed table's rows after `after` (a rowid; 0 for the first), in the order they were written, at most `limit`;
     *  maxBytes bounds the page by a size-only pass before full rows are read. Answers { rows, last } (last: the rowid
     *  to continue after). */
    sealedLogPage(table, after, limit, maxBytes = null) {
      if (!sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      let take = limit;
      if (maxBytes !== null) {
        // Read only sizes first: 1,024 wide log rows must not all enter the isolate just because the row-count cap fits.
        // octet_length is answered from each row's header, never its text (CAST AS BLOB loaded every whole value).
        const sizes = sql.exec(`SELECT 256
          + COALESCE(octet_length(record_id), 0)
          + COALESCE(octet_length(table_name), 0)
          + COALESCE(octet_length(patch), 0)
          + COALESCE(octet_length(transaction_id), 0)
          + COALESCE(octet_length(actor_context), 0)
          + COALESCE(octet_length(application_time), 0)
          + COALESCE(octet_length(system_time), 0) AS estimated_bytes
          FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, limit);
        take = 0;
        let bytes = 0;
        for (const { estimated_bytes } of sizes) {
          if (take === 0 && estimated_bytes > maxBytes * 4) throw new Error('One record history row is too large to archive in memory.');
          if (take && bytes + estimated_bytes > maxBytes) break;
          take += 1;
          bytes += estimated_bytes;
        }
      }
      if (!take) return { rows: [], last: after, rowids: [] };
      const read = all(`SELECT rowid AS log_rowid, id, record_id, table_name, patch, transaction_id, actor_context, application_time, system_time FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, take);
      return { rows: read.map(({ log_rowid, ...row }) => row), last: read.length ? read.at(-1).log_rowid : after, rowids: read.map(row => row.log_rowid) };
    },
    /** The last rowid of a sealed table the host has kept elsewhere (0 when none), and recording it after each page:
     *  one row written per page kept. */
    sealedLogKept: table => all('SELECT kept_through FROM bitemporal_facts_moves WHERE sealed_table = ?', table)[0]?.kept_through ?? 0,
    keepSealedLogThrough(table, rowid, { reclaim = false } = {}) {
      if (reclaim && !sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      transaction(() => {
        const after = reclaim ? all('SELECT kept_through FROM bitemporal_facts_moves WHERE sealed_table = ? LIMIT 1', table)[0]?.kept_through ?? 0 : 0;
        if (reclaim) {
          if (!Number.isSafeInteger(rowid) || rowid < after) throw new Error('A kept history page must advance its sealed rowid.');
          sql.exec(`DELETE FROM ${table} WHERE rowid > ? AND rowid <= ?`, after, rowid);
        }
        sql.exec('INSERT INTO bitemporal_facts_moves (sealed_table, kept_through) VALUES (?, ?) ON CONFLICT (sealed_table) DO UPDATE SET kept_through = excluded.kept_through', table, rowid);
      });
    },
    /** Lets go of a sealed table whole, once the host has kept every row of it elsewhere. */
    dropSealedLog(table) {
      if (!sealedLogs().includes(table)) throw new Error(`${table} is not a sealed log.`);
      transaction(() => {
        sql.exec(`DROP TABLE ${table}`);
        sql.exec('DELETE FROM bitemporal_facts_moves WHERE sealed_table = ?', table);
      });
      sealedLogNames = null;
    },
    /** The log rows of one transaction or of one row address still in the database, oldest first (a scan of every log
     *  table: the log keeps no index, and nothing but this reads it by them). */
    log({ transaction_id, record_id } = {}) {
      if (!transaction_id && !record_id) throw new Error('log needs a transaction_id or a record_id');
      const [column, value] = transaction_id ? ['transaction_id', transaction_id] : ['record_id', record_id];
      return [...sealedLogs(), LOG_TABLE].flatMap(table => all(`SELECT id, record_id, table_name, patch, transaction_id, actor_context, application_time, system_time FROM ${table} WHERE ${column} = ? ORDER BY rowid`, value));
    },
  };
}
