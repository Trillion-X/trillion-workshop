import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const KINDS = '_record_tables_kinds';
const FIELDS = '_record_tables_fields';
const HISTORY = '_record_tables_history';
const INDEXES = '_record_tables_indexes';
const q = value => `"${String(value).replaceAll('"', '""')}"`;
const textLiteral = value => `CAST(X'${bytesToHex(new TextEncoder().encode(value))}' AS TEXT)`;
const hash = value => bytesToHex(blake3(new TextEncoder().encode(value)));
const tableName = type => `rt_${hash(JSON.stringify(['kind', type]))}`;
const fieldColumn = (type, field, generation) => `f_${hash(JSON.stringify(['field', type, field, generation]))}`;
// The most rows (and characters of their values) one statement writes to a kind's table.
const PUT_ROWS = 64;
const PUT_CHARS = 512 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeNames = new Map([['text', 'text'], ['string', 'text'], ['id', 'text'], ['number', 'number'], ['boolean', 'boolean'], ['list', 'list'], ['texts', 'list'], ['numbers', 'list'], ['objects', 'list'], ['row-ids', 'list'], ['date', 'text'], ['file', 'text'], ['any', 'json'], ['object', 'json'], ['json', 'json']]);
// How a typed table is laid out: WITHOUT ROWID, so a row saved is one write (its _id is the table's own key) where a
// rowid table writes the row and its primary-key index. A change here is a new build signature (record-log-store.mjs).
export const LAYOUT = 'without-rowid-canonical-json-index-order';
const BASE_COLUMNS = ['_id', '_deleted', '_changed_at', '_transaction_id', '_actor', '_value_json', '_index_values'];
const COLUMN_LIMIT = 100;
const ACTIVE_FIELD_LIMIT = COLUMN_LIMIT - BASE_COLUMNS.length;
const affinity = { text: 'TEXT', number: 'REAL', boolean: 'INTEGER', list: 'TEXT', json: 'TEXT' };

export class RecordTableSchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RecordTableSchemaError';
    this.code = 'record_table_schema_incompatible';
    Object.assign(this, details);
  }
}

const propertyType = (value, valueKinds = {}) => {
  const shape = typeof value === 'string' ? (valueKinds[value] ?? value) : value;
  const raw = typeof shape === 'string' ? shape : shape?.is ?? (shape?.list_of ? 'list' : 'json');
  const type = typeNames.get(raw);
  return type ?? 'json';
};

function encode(value, type, field) {
  if (value === null || value === undefined) return null;
  if (type === 'text' && typeof value === 'string') return value;
  if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return value;
  if (type === 'boolean' && typeof value === 'boolean') return Number(value);
  if (type === 'list' && Array.isArray(value)) return JSON.stringify(value);
  if (type === 'json') return JSON.stringify(value);
  throw new RecordTableSchemaError(`Field ${field} must have the declared ${type} value type.`, { field, expected: type });
}

function decode(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return value === true || value === 1;
  if (type === 'list' || type === 'json') return JSON.parse(value);
  return value;
}

// Packed record indexes order each field by JSON.stringify(value), then the
// record id. Dynamic SQL indexes must use the same bytewise tuple key even
// though their projection columns use SQLite's native affinities.
function indexKeyExpression(field) {
  // Keep the original JavaScript JSON spelling. SQLite REAL values can turn
  // 1 into 1.0, which changes bytewise tuple order and cursor comparisons.
  const path = `$."${field.column_name}"`;
  return `json_extract(${q('_index_values')}, ${textLiteral(path)})`;
}
const indexKey = value => JSON.stringify(value);

function stamp(context = {}) {
  const actor = context.actor === undefined ? null : JSON.stringify(context.actor);
  const transaction = context.transaction_id ?? context.transaction ?? context.tx_id ?? null;
  return {
    changed_at: String(context.at ?? context.changed_at ?? context.recorded_at ?? new Date().toISOString()),
    transaction_id: transaction === null ? null : String(transaction),
    actor,
  };
}

/** Typed SQL projection for customer-declared kinds. The record log remains authoritative. */
/** onSchemaChange(change) hears each dated schema change as it is made, so the store keeps it as a record of the log
 *  in the same transaction (record-log-store.mjs commit); the history table here answers paged reads of the same. */
export function recordTables({ sql, kindOf, valueKinds = {}, onSchemaChange = null }) {
  if (typeof sql?.exec !== 'function') throw new TypeError('recordTables needs sql.exec.');
  if (typeof kindOf !== 'function') throw new TypeError('recordTables needs kindOf(type).');

  // The tables whose layout was read this time the store opened, so a save reads sqlite_master once per table.
  const laidOut = new Set();
  // The metadata tables a store has seen present. They are made together by createMetadata and nothing drops them, so a
  // yes is kept for this store and the catalog is not scanned again; a no is never kept. replay() (a rollback that took
  // them back) calls forgetReady.
  const presentTables = new Set();
  const tableReady = name => {
    if (presentTables.has(name)) return true;
    if (!sql.exec("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()[0]) return false;
    presentTables.add(name);
    return true;
  };
  const createTable = (table, columns = []) => sql.exec(`CREATE TABLE ${q(table)} (_id TEXT PRIMARY KEY NOT NULL, _deleted INTEGER NOT NULL DEFAULT 0, _changed_at TEXT, _transaction_id TEXT, _actor TEXT, _value_json TEXT NOT NULL DEFAULT '{}', _index_values TEXT NOT NULL DEFAULT '{}'${columns.map(column => `, ${q(column.name)} ${column.type}`).join('')}) WITHOUT ROWID`);

  function createMetadata() {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${q(KINDS)} (kind TEXT PRIMARY KEY, table_name TEXT NOT NULL UNIQUE)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${q(FIELDS)} (kind TEXT NOT NULL, field TEXT NOT NULL, generation INTEGER NOT NULL, value_type TEXT NOT NULL, column_name TEXT NOT NULL, declared INTEGER NOT NULL, PRIMARY KEY(kind, field, generation), UNIQUE(kind, column_name))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${q(INDEXES)} (kind TEXT NOT NULL, index_name TEXT NOT NULL, definition TEXT NOT NULL, physical_name TEXT NOT NULL UNIQUE, PRIMARY KEY(kind, index_name, definition))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ${q(HISTORY)} (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, changed_at TEXT NOT NULL, transaction_id TEXT, actor TEXT, event TEXT NOT NULL, field TEXT, old_type TEXT, new_type TEXT)`);
  }

  function event(type, name, context, details = {}) {
    const at = stamp(context);
    sql.exec(`INSERT INTO ${q(HISTORY)} (kind, changed_at, transaction_id, actor, event, field, old_type, new_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, type, at.changed_at, at.transaction_id, at.actor, name, details.field ?? null, details.old_type ?? null, details.new_type ?? null);
    onSchemaChange?.({ kind: type, event: name, field: details.field ?? null, old_type: details.old_type ?? null, new_type: details.new_type ?? null, changed_at: at.changed_at });
  }

  function requireKind(type) {
    if (typeof type !== 'string' || !type) throw new TypeError('A record kind type is required.');
    const kind = kindOf(type);
    if (!(kind?.declared_by || kind?.table === true || kind?.customer_declared === true)) throw new RecordTableSchemaError(`Record kind ${type} is not customer-declared.`, { kind: type });
    if (!isObject(kind.properties)) throw new RecordTableSchemaError(`Record kind ${type} has no declared properties.`, { kind: type });
    return kind;
  }

  function latestFields(type) {
    const result = new Map();
    const exists = tableReady(FIELDS);
    if (!exists) return result;
    for (const row of sql.exec(`SELECT field, generation, value_type, column_name, declared FROM ${q(FIELDS)} WHERE kind = ? ORDER BY field, generation`, type).toArray()) result.set(row.field, row);
    return result;
  }

  function ensureSchema(type, context = {}) {
    createMetadata();
    const kind = requireKind(type);
    const table = tableName(type);
    const declared = new Map(Object.entries(kind.properties).map(([field, shape]) => [field, propertyType(shape, valueKinds)]));
    if ([...declared.keys()].some(field => !field)) throw new RecordTableSchemaError(`Record kind ${type} declares an empty field name.`, { kind: type });
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    if (registered && registered.table_name !== table) throw new RecordTableSchemaError(`Stored table identity for ${type} is inconsistent.`, { kind: type });
    if (!registered) {
      const collision = sql.exec(`SELECT kind FROM ${q(KINDS)} WHERE table_name = ?`, table).toArray()[0];
      if (collision) throw new RecordTableSchemaError(`Table-name collision between ${type} and ${collision.kind}.`, { kind: type, collision: collision.kind });
      if (declared.size > ACTIVE_FIELD_LIMIT) throw new RecordTableSchemaError(`This database supports at most ${ACTIVE_FIELD_LIMIT} active table fields.`, { kind: type, limit: ACTIVE_FIELD_LIMIT });
      // A fresh kind has no earlier physical generations. Declare its complete initial layout once; adding every
      // field separately scans the host's schema once per ALTER, before the first record can be kept.
      createTable(table, [...declared].map(([field, typeName]) => ({ name: fieldColumn(type, field, 0), type: affinity[typeName] })));
      sql.exec(`INSERT INTO ${q(KINDS)} (kind, table_name) VALUES (?, ?)`, type, table);
      event(type, 'kind_added', context);
    } else if (!laidOut.has(table)) {
      // A table made before LAYOUT (a rowid table, whose row and primary-key index are two writes per row saved) is
      // made again WITHOUT ROWID with the same columns, empty: the store fills it again from the log, since LAYOUT is
      // part of each kind's build signature (record-log-store.mjs buildTables). Its indexes are made again below.
      const made = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0]?.sql ?? '';
      const hasIndexValues = sql.exec(`PRAGMA table_info(${q(table)})`).toArray().some(column => column.name === '_index_values');
      if (!/WITHOUT ROWID\s*$/i.test(made) || !hasIndexValues) {
        const columns = sql.exec(`PRAGMA table_info(${q(table)})`).toArray().filter(column => !BASE_COLUMNS.includes(column.name));
        sql.exec(`DROP TABLE IF EXISTS ${q(table)}`);
        createTable(table, columns);
        sql.exec(`DELETE FROM ${q(INDEXES)} WHERE kind = ?`, type);
        event(type, 'table_rebuilt', context);
      }
    }
    laidOut.add(table);

    const previousFields = latestFields(type);
    const addColumn = (column, typeName) => {
      let physical = sql.exec(`PRAGMA table_info(${q(table)})`).toArray();
      if (physical.length >= COLUMN_LIMIT) {
        // The hosted SQLite owner permits 100 physical columns. Older generations and removed fields can be
        // compacted without changing a saved value: full values and the log retain them, and history stays dated.
        const live = new Set([...declared.keys()].map(field => previousFields.get(field)?.column_name).filter(Boolean));
        const retired = sql.exec(`SELECT column_name FROM ${q(FIELDS)} WHERE kind = ? ORDER BY field, generation`, type).toArray()
          .map(row => row.column_name).find(name => !live.has(name) && physical.some(column => column.name === name));
        if (!retired) throw new RecordTableSchemaError(`This database supports at most ${ACTIVE_FIELD_LIMIT} active table fields.`, { kind: type, limit: ACTIVE_FIELD_LIMIT });
        for (const index of sql.exec(`SELECT physical_name FROM ${q(INDEXES)} WHERE kind = ?`, type).toArray()) sql.exec(`DROP INDEX IF EXISTS ${q(index.physical_name)}`);
        sql.exec(`DELETE FROM ${q(INDEXES)} WHERE kind = ?`, type);
        sql.exec(`ALTER TABLE ${q(table)} DROP COLUMN ${q(retired)}`);
      }
      sql.exec(`ALTER TABLE ${q(table)} ADD COLUMN ${q(column)} ${affinity[typeName]}`);
    };

    for (const [field, typeName] of declared) {
      let previous = previousFields.get(field);
      if (!previous) {
        const column = fieldColumn(type, field, 0);
        if (registered) addColumn(column, typeName);
        sql.exec(`INSERT INTO ${q(FIELDS)} (kind, field, generation, value_type, column_name, declared) VALUES (?, ?, 0, ?, ?, 1)`, type, field, typeName, column);
        event(type, 'field_added', context, { field, new_type: typeName });
        previousFields.set(field, { field, generation: 0, value_type: typeName, column_name: column, declared: 1 });
        continue;
      }
      if (previous.value_type !== typeName) {
        const generation = previous.generation + 1;
        const column = fieldColumn(type, field, generation);
        // This generation replaces its predecessor; the predecessor can be compacted at the physical limit.
        previousFields.set(field, { ...previous, column_name: column });
        addColumn(column, typeName);
        // Historical rows retain their original JSON value. A bounded owner can fill this generation's typed column
        // from that value later; declaration changes never scan or rewrite the whole kind here.
        sql.exec(`INSERT INTO ${q(FIELDS)} (kind, field, generation, value_type, column_name, declared) VALUES (?, ?, ?, ?, ?, 1)`, type, field, generation, typeName, column);
        event(type, 'field_type_changed', context, { field, old_type: previous.value_type, new_type: typeName });
        previous = { field, generation, value_type: typeName, column_name: column, declared: 1 };
        previousFields.set(field, previous);
      } else if (!previous.declared) {
        if (!sql.exec(`PRAGMA table_info(${q(table)})`).toArray().some(column => column.name === previous.column_name)) addColumn(previous.column_name, typeName);
        sql.exec(`UPDATE ${q(FIELDS)} SET declared = 1 WHERE kind = ? AND field = ? AND generation = ?`, type, field, previous.generation);
        event(type, 'field_restored', context, { field, new_type: typeName });
      }
    }

    for (const [field, previous] of previousFields) {
      if (previous.declared && !declared.has(field)) {
        sql.exec(`UPDATE ${q(FIELDS)} SET declared = 0 WHERE kind = ? AND field = ? AND generation = ?`, type, field, previous.generation);
        event(type, 'field_removed', context, { field, old_type: previous.value_type });
      }
    }

    const fields = latestFields(type);
    const desiredIndexes = new Set();
    for (const index of kind.indexes ?? []) {
      if (!index || typeof index.name !== 'string' || !index.name || !Array.isArray(index.fields) || !index.fields.length) throw new RecordTableSchemaError(`An index of ${type} needs a name and at least one field.`, { kind: type });
      const columns = index.fields.map(field => {
        if (!declared.has(field)) throw new RecordTableSchemaError(`Index ${index.name} on ${type} names undeclared field ${field}.`, { kind: type, index: index.name, field });
        return fields.get(field).column_name;
      });
      const indexFields = index.fields.map(field => fields.get(field));
      const keys = indexFields.map(indexKeyExpression);
      const definition = JSON.stringify({ fields: index.fields, columns, keys });
      desiredIndexes.add(JSON.stringify([index.name, definition]));
      for (const old of sql.exec(`SELECT definition, physical_name FROM ${q(INDEXES)} WHERE kind = ? AND index_name = ? AND definition <> ?`, type, index.name, definition).toArray()) {
        sql.exec(`DROP INDEX IF EXISTS ${q(old.physical_name)}`);
        sql.exec(`DELETE FROM ${q(INDEXES)} WHERE kind = ? AND index_name = ? AND definition = ?`, type, index.name, old.definition);
      }
      const exists = sql.exec(`SELECT physical_name FROM ${q(INDEXES)} WHERE kind = ? AND index_name = ? AND definition = ?`, type, index.name, definition).toArray()[0];
      if (!exists) {
        const physical = `rti_${hash(JSON.stringify([type, index.name, definition]))}`;
        const collision = sql.exec(`SELECT kind, index_name FROM ${q(INDEXES)} WHERE physical_name = ?`, physical).toArray()[0];
        if (collision) throw new RecordTableSchemaError(`Index-name collision for ${type}.${index.name}.`, { kind: type, index: index.name });
        sql.exec(`CREATE INDEX ${q(physical)} ON ${q(table)} (${keys.join(', ')}, _id) WHERE _deleted = 0`);
        sql.exec(`INSERT INTO ${q(INDEXES)} (kind, index_name, definition, physical_name) VALUES (?, ?, ?, ?)`, type, index.name, definition, physical);
        event(type, 'index_added', context, { field: index.name });
      }
    }
    for (const old of sql.exec(`SELECT index_name, definition, physical_name FROM ${q(INDEXES)} WHERE kind = ?`, type).toArray()) {
      if (desiredIndexes.has(JSON.stringify([old.index_name, old.definition]))) continue;
      sql.exec(`DROP INDEX IF EXISTS ${q(old.physical_name)}`);
      sql.exec(`DELETE FROM ${q(INDEXES)} WHERE kind = ? AND index_name = ? AND definition = ?`, type, old.index_name, old.definition);
      event(type, 'index_removed', context, { field: old.index_name });
    }
    return { kind, table, declared, fields };
  }

  function ensure(type, context = {}) { return ensureSchema(type, context); }

  function schema(type) {
    const kind = requireKind(type);
    const hasKinds = tableReady(KINDS);
    if (!hasKinds) return { type, table: tableName(type), declared_by: kind.declared_by ?? 'customer',
      fields: Object.entries(kind.properties).map(([field, shape]) => ({ field, value_type: propertyType(shape, valueKinds), column: null })),
      indexes: (kind.indexes ?? []).map(index => ({ name: index.name, fields: [...index.fields] })) };
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    const declared = new Map(Object.entries(kind.properties).map(([field, shape]) => [field, propertyType(shape, valueKinds)]));
    const fields = latestFields(type);
    const table = registered?.table_name ?? tableName(type);
    // The table's own SQL as SQLite keeps it (every ALTER TABLE ADD COLUMN folded into its CREATE TABLE) and its indexes'.
    const statements = registered ? sql.exec("SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type DESC, name", table).toArray().map(row => row.sql) : [];
    return { type, table, declared_by: kind.declared_by ?? 'customer',
      fields: [...declared].map(([field, value_type]) => ({ field, value_type, column: fields.get(field)?.column_name ?? null })),
      indexes: (kind.indexes ?? []).map(index => ({ name: index.name, fields: [...index.fields] })), statements };
  }

  function tombstone(id, type, context = {}) {
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    if (!registered) return false;
    const at = stamp(context);
    const found = sql.exec(`SELECT 1 AS present FROM ${q(registered.table_name)} WHERE _id = ? AND _deleted = 0`, id).toArray()[0];
    if (!found) return false;
    sql.exec(`UPDATE ${q(registered.table_name)} SET _deleted = 1, _changed_at = ?, _transaction_id = ?, _actor = ? WHERE _id = ? AND _deleted = 0`, at.changed_at, at.transaction_id, at.actor, id);
    return true;
  }

  // Records of a kind are written to its table together, PUT_ROWS (or PUT_CHARS of their values) a statement: on the
  // founder's own records (2026-10-20) one tool run wrote 522 rows one statement each, an eighth of its 4,000-statement
  // bound. schemas: a caller's Map type -> ensured schema for the rows of one write, so its rows of one kind ensure the
  // kind's table once (about nine statements), not once a row; the caller forgets a kind it ensures again (ensure)
  // meanwhile. -> [{ id, type }] in the order given
  function putMany(records, context = {}, schemas = null) {
    for (const record of records)
      if (!record || typeof record.id !== 'string' || !record.id || typeof record.type !== 'string' || !isObject(record.value)) throw new TypeError('put needs { id, type, value } with an object value.');
    const byType = new Map();
    for (const record of records) {
      const declaredKind = requireKind(record.type);
      if (context.validate !== false) for (const [field, shape] of Object.entries(declaredKind.properties)) encode(record.value[field], propertyType(shape, valueKinds), field);
      if (!byType.has(record.type)) byType.set(record.type, []);
      byType.get(record.type).push(record);
    }
    const at = stamp(context);
    for (const [type, ofType] of byType) {
      const current = schemas?.get(type) ?? ensureSchema(type, context);
      schemas?.set(type, current);
      const fields = [...current.declared.keys()];
      const columns = ['_id', '_deleted', '_changed_at', '_transaction_id', '_actor', '_value_json', '_index_values', ...fields.map(field => current.fields.get(field).column_name)];
      const acceptedJsonTypes = { text: "'text'", number: "'integer', 'real'", boolean: "'true', 'false'", list: "'array'", json: "'object', 'array', 'text', 'integer', 'real', 'true', 'false'" };
      const typedValues = fields.map(field => {
        const expected = current.declared.get(field);
        const types = acceptedJsonTypes[expected];
        return `(SELECT CASE WHEN j.type = 'null' OR j.type IN (${types}) THEN j.value ELSE NULL END FROM json_each(source.doc) AS j WHERE j.key = ${textLiteral(field)})`;
      });
      const assignments = columns.slice(1).map(column => `${q(column)} = excluded.${q(column)}`).join(', ');
      const typedChanged = fields.map(field => `${q(current.table)}.${q(current.fields.get(field).column_name)} IS NOT excluded.${q(current.fields.get(field).column_name)}`).join(' OR ');
      // Each row is [id, value JSON, index values JSON]; the stamp is the write's, bound once.
      const query = `WITH source(id, doc, changed_at, transaction_id, actor, index_values) AS (SELECT json_extract(given.value, '$[0]'), json_extract(given.value, '$[1]'), ?, ?, ?, json_extract(given.value, '$[2]') FROM json_each(?) AS given) INSERT INTO ${q(current.table)} (${columns.map(q).join(', ')}) SELECT source.id, 0, source.changed_at, source.transaction_id, source.actor, source.doc, source.index_values${typedValues.length ? `, ${typedValues.join(', ')}` : ''} FROM source WHERE 1 ON CONFLICT(_id) DO UPDATE SET ${assignments} WHERE ${q(current.table)}._deleted <> excluded._deleted OR ${q(current.table)}._value_json IS NOT excluded._value_json${typedChanged ? ` OR ${typedChanged}` : ''}`;
      let rows = [], chars = 0;
      const flush = () => { if (rows.length) sql.exec(query, at.changed_at, at.transaction_id, at.actor, JSON.stringify(rows)); rows = []; chars = 0; };
      for (const record of ofType) {
        const json = JSON.stringify(record.value);
        const indexValues = Object.fromEntries(fields.flatMap(field => {
          const value = record.value[field];
          return value === undefined ? [] : [[current.fields.get(field).column_name, JSON.stringify(value)]];
        }));
        const row = [record.id, json, JSON.stringify(indexValues)];
        const size = row[0].length + row[1].length + row[2].length;
        if (rows.length && (rows.length >= PUT_ROWS || chars + size > PUT_CHARS)) flush();
        rows.push(row);
        chars += size;
      }
      flush();
    }
    return records.map(record => ({ id: record.id, type: record.type }));
  }
  const put = (record, context = {}, schemas = null) => putMany([record], context, schemas)[0];

  function remove(id, type, context = {}) {
    if (typeof id !== 'string' || !id || (type !== undefined && (typeof type !== 'string' || !type))) throw new TypeError('remove needs an id and an optional type.');
    if (type === undefined) return false;
    const hasKinds = tableReady(KINDS);
    if (!hasKinds) return false;
    return tombstone(id, type, context);
  }

  function rowOf(row, type, fieldRows) {
    const value = JSON.parse(row._value_json ?? '{}');
    // SQLite affinities can coerce retained values after a declaration changes. Return the saved JSON exactly;
    // the typed cells remain available for SQL indexes and schema inspection.
    return { id: row._id, type, value, changed_at: row._changed_at ?? null, transaction_id: row._transaction_id ?? null, actor: row._actor ? JSON.parse(row._actor) : null };
  }

  function read(id, type) {
    const hasKinds = tableReady(KINDS);
    if (!hasKinds) return null;
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    if (!registered) return null;
    const row = sql.exec(`SELECT * FROM ${q(registered.table_name)} WHERE _id = ? AND _deleted = 0`, id).toArray()[0];
    if (!row) return null;
    const fields = sql.exec(`SELECT f.field, f.value_type, f.column_name FROM ${q(FIELDS)} f WHERE f.kind = ? AND f.declared = 1 AND f.generation = (SELECT max(f2.generation) FROM ${q(FIELDS)} f2 WHERE f2.kind = f.kind AND f2.field = f.field) ORDER BY f.field`, type).toArray();
    return rowOf(row, type, fields);
  }

  function rows(type, { after = null, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('rows limit must be between 1 and 1000.');
    const hasKinds = tableReady(KINDS);
    if (!hasKinds) return [];
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    if (!registered) return [];
    const found = after === null
      ? sql.exec(`SELECT * FROM ${q(registered.table_name)} WHERE _deleted = 0 ORDER BY _id LIMIT ?`, limit).toArray()
      : sql.exec(`SELECT * FROM ${q(registered.table_name)} WHERE _deleted = 0 AND _id > ? ORDER BY _id LIMIT ?`, after, limit).toArray();
    const fields = sql.exec(`SELECT f.field, f.value_type, f.column_name FROM ${q(FIELDS)} f WHERE f.kind = ? AND f.declared = 1 AND f.generation = (SELECT max(f2.generation) FROM ${q(FIELDS)} f2 WHERE f2.kind = f.kind AND f2.field = f.field) ORDER BY f.field`, type).toArray();
    return found.map(row => rowOf(row, type, fields));
  }

  // A customer-declared index reads the typed table directly. Its expression
  // keys match the packed record index's JSON-spelling tuple order, followed
  // by the record id, so paging and ties agree across both owners.
  function scanIndex(type, name, { equal = [], from, to, after, after_id, before, startsWith, idFrom, idTo,
    reverse = false, limit = 100 } = {}) {
    if (!Array.isArray(equal)) throw new TypeError('Index equality needs an array of values.');
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new RangeError('Index scan limit must be between 0 and 1000.');
    const kind = requireKind(type);
    const index = (kind.indexes ?? []).find(item => item.name === name);
    if (!index) throw new Error(`No index named ${name} is declared for ${type} records.`);
    if (equal.length > index.fields.length) throw new Error(`Index ${name} has fewer fields than the equality prefix.`);
    if (after_id !== undefined && (typeof after_id !== 'string' || !after_id || after === undefined || index.fields.length !== equal.length + 1 || from !== undefined || startsWith !== undefined))
      throw new Error('after_id needs an exclusive value and record id for the final index field.');
    const registered = sql.exec(`SELECT table_name FROM ${q(KINDS)} WHERE kind = ?`, type).toArray()[0];
    if (!registered) return [];
    const table = registered.table_name;
    const currentFields = latestFields(type);
    const fields = index.fields.map(field => currentFields.get(field));
    if (fields.some(field => !field || !field.declared)) throw new RecordTableSchemaError(`Index ${name} on ${type} has an unavailable field.`, { kind: type, index: name });
    const expressions = fields.map(indexKeyExpression);
    const where = ['_deleted = 0', ...fields.map(field => `${q(field.column_name)} IS NOT NULL`)];
    const params = [];
    equal.forEach((value, at) => {
      where.push(`${expressions[at]} = ?`);
      params.push(indexKey(value));
    });
    if (equal.length < fields.length) {
      const expression = expressions[equal.length];
      for (const [operator, value] of [['>=', from], ...(after_id === undefined ? [['>', after]] : []), ['<=', to], ['<', before]]) {
        if (value === undefined) continue;
        where.push(`${expression} ${operator} ?`);
        params.push(indexKey(value));
      }
      if (after_id !== undefined) {
        const encoded = indexKey(after);
        where.push(`(${expression} > ? OR (${expression} = ? AND _id > ?))`);
        params.push(encoded, encoded, after_id);
      }
      if (startsWith !== undefined) {
        if (typeof startsWith !== 'string') throw new TypeError('Index startsWith needs text.');
        if (fields[equal.length].value_type !== 'text') throw new TypeError('Index startsWith needs a text field.');
        where.push(`substr(${expression}, 1, length(?)) = ?`);
        const prefix = JSON.stringify(startsWith).slice(0, -1);
        params.push(prefix, prefix);
      }
    } else {
      if (idFrom !== undefined) { where.push('_id >= ?'); params.push(idFrom); }
      if (idTo !== undefined) { where.push('_id < ?'); params.push(idTo); }
    }
    const direction = reverse ? 'DESC' : 'ASC';
    const order = [...expressions.map(expression => `${expression} ${direction}`), `_id ${direction}`].join(', ');
    const columns = fields.map((field, at) => `${q(field.column_name)} AS v${at}`).join(', ');
    const found = sql.exec(`SELECT _id AS id, ${columns} FROM ${q(table)} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`, ...params, limit).toArray();
    return found.map(row => ({ id: row.id, values: fields.map((field, at) => decode(row[`v${at}`], field.value_type)) }));
  }

  function schemaHistory({ type = null, after = 0, limit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('schemaHistory needs a non-negative cursor and a limit from 1 to 1000.');
    const exists = tableReady(HISTORY);
    if (!exists) return [];
    const found = type === null
      ? sql.exec(`SELECT * FROM ${q(HISTORY)} WHERE sequence > ? ORDER BY sequence LIMIT ?`, after, limit).toArray()
      : sql.exec(`SELECT * FROM ${q(HISTORY)} WHERE kind = ? AND sequence > ? ORDER BY sequence LIMIT ?`, type, after, limit).toArray();
    return found.map(row => ({ sequence: row.sequence, kind: row.kind, changed_at: row.changed_at, transaction_id: row.transaction_id, actor: row.actor ? JSON.parse(row.actor) : null, event: row.event, field: row.field, old_type: row.old_type, new_type: row.new_type }));
  }

  function tables() {
    const present = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?)", KINDS, FIELDS, HISTORY, INDEXES).toArray().map(row => row.name);
    if (!present.includes(KINDS)) return present;
    // Read exact registered names; no prefix glob can absorb an unrelated owner's table.
    return [...sql.exec(`SELECT table_name FROM ${q(KINDS)} ORDER BY kind`).toArray().map(row => row.table_name), ...present];
  }
  /** The last schema change's sequence, 0 when none was ever made. */
  function lastSequence() {
    const exists = tableReady(HISTORY);
    return exists ? Number(sql.exec(`SELECT MAX(sequence) AS last FROM ${q(HISTORY)}`).toArray()[0]?.last ?? 0) : 0;
  }

  return { ensure, schema, put, putMany, remove, read, rows, scanIndex, schemaHistory, lastSequence, tables, layout: LAYOUT, forgetReady: () => presentTables.clear() };
}
