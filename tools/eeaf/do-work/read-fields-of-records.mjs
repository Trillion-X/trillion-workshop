// tools/eeaf/do-work/read-fields-of-records.mjs
//
// The EEAF field reads (eeaf-field-reads.mjs) as one run over an in-memory SQLite database (node:sqlite) laid out from
// the records given in the input. The database is made with the store's own tables, the CREATE statements of entity,
// entity_types, type_properties and attribute_fact read from eeaf-sqlite-store.mjs as text (that module itself is not
// loaded: it imports parts/record-log's record-log-store.mjs, which the Workshop does not have). Each record's own
// top-level values (scalars and lists of scalars) become its attribute facts under the store's ids (`type:<type>`,
// `prop:<type>:<field>`, the value as JSON), as the store's decompose() writes them; a field holding an object or a list
// of objects lives on child subjects in the store, is never answered by a field read, and is named in left_out. Then
// the reads are answered in order. Nothing is kept after the run and no file is written.
//
// Input:
//   records  [{ id, type, value }]: whole root records (value an object; an id holds one type, given once)
//   reads    [{ name?, op, type, ... }], each answered under its name (its place in the list, "0", "1", ..., when
//            left out), and each one of
//            fieldsOf        { type, ids, fields }            → records: [{ id, ...fields }] of those ids held as type
//            after           { type, field, after, fields?, limit?, after_id? } → records whose field sorts after `after`
//            newestPerGroup  { type, group, order, fields? }  → records: one per value of group, the largest order
//            idsWhere        { type, field, value, limit? }   → ids whose field is exactly value
// Answers { answers: { <name>: { op, type, count, records | ids } }, held: { records, facts }, left_out: [{ id, field }] }.
// Refuses a record without a string id and type or with a value that is not an object, the same id given twice, a read
// with an op it does not know, a read missing what its op needs, and two reads with the same name.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { eeafFieldReads } from './eeaf-field-reads.mjs';

const TABLES = ['entity', 'entity_types', 'type_properties', 'attribute_fact'];
const OPS = {
  fieldsOf: ['ids', 'fields'],
  after: ['field', 'after'],
  newestPerGroup: ['group', 'order'],
  idsWhere: ['field', 'value'],
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isListOfObjects = value => Array.isArray(value) && value.some(item => item !== null && typeof item === 'object');

// The store's CREATE statements for the tables a field read reads, exactly as eeaf-sqlite-store.mjs writes them.
function storeStatements() {
  const text = readFileSync(new URL('./eeaf-sqlite-store.mjs', import.meta.url), 'utf8');
  const statements = [...text.matchAll(/'(CREATE (?:TABLE|INDEX) IF NOT EXISTS [^']+)'/g)].map(match => match[1]);
  const tableOf = statement => (/^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement) ?? / ON (\w+)\(/.exec(statement))?.[1];
  const named = statements.filter(statement => TABLES.includes(tableOf(statement)));
  for (const table of TABLES) {
    if (!named.some(statement => statement.startsWith(`CREATE TABLE IF NOT EXISTS ${table} `))) throw new Error(`eeaf-sqlite-store.mjs no longer creates the table ${table}; this run cannot lay out the store.`);
  }
  return named;
}

// The node:sqlite handle in the shape the store and its reads take: exec(query, ...params).toArray().
function sqlOver(db) {
  return {
    exec(query, ...params) {
      // all() runs a statement that answers no rows too, and answers [] for it.
      const rows = db.prepare(query).all(...params);
      return { toArray: () => rows.map(row => ({ ...row })) };
    },
  };
}

export function readFieldsOfRecords({ records, reads } = {}) {
  if (!Array.isArray(records)) throw new Error('Give records: [{ id, type, value }], the root records to read fields of.');
  if (!Array.isArray(reads) || reads.length === 0) throw new Error(`Give reads: a list of { op, type, ... } (ops: ${Object.keys(OPS).join(', ')}).`);
  const db = new DatabaseSync(':memory:');
  const sql = sqlOver(db);
  for (const statement of storeStatements()) sql.exec(statement);
  const ensure = { entity: new Set(), types: new Set(), props: new Set() };
  const entity = id => { if (!ensure.entity.has(id)) { sql.exec('INSERT INTO entity (id) VALUES (?)', id); ensure.entity.add(id); } };
  const typed = (id, type) => { const key = `${id}\u0000${type}`; if (!ensure.types.has(key)) { sql.exec('INSERT INTO entity_types (entity_id, type_id) VALUES (?, ?)', id, type); ensure.types.add(key); } };
  const typeEntity = type => { entity(type); entity('type:type'); typed(type, 'type:type'); };
  const property = (type, prop) => {
    typeEntity(type); typeEntity('type:property'); entity(prop); typed(prop, 'type:property');
    const key = `${type}\u0000${prop}`;
    if (!ensure.props.has(key)) { sql.exec('INSERT INTO type_properties (type_id, property_id) VALUES (?, ?)', type, prop); ensure.props.add(key); }
  };
  const seen = new Set();
  const leftOut = [];
  let facts = 0;
  records.forEach((record, index) => {
    const { id, type, value } = record ?? {};
    if (typeof id !== 'string' || !id || id.includes('/')) throw new Error(`records[${index}] needs id: a non-empty string without '/'.`);
    if (typeof type !== 'string' || !type) throw new Error(`records[${index}] (${id}) needs type: a non-empty string.`);
    if (!isObject(value)) throw new Error(`records[${index}] (${id}) needs value: an object.`);
    if (seen.has(id)) throw new Error(`records[${index}]: ${id} is given twice; give each record once.`);
    seen.add(id);
    const typeId = `type:${type}`;
    typeEntity(typeId);
    entity(id);
    typed(id, typeId);
    for (const [field, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (isObject(item) || isListOfObjects(item)) { leftOut.push({ id, field }); continue; }
      const prop = `prop:${type}:${field}`;
      property(typeId, prop);
      sql.exec('INSERT INTO attribute_fact (subject_id, property_id, type_id, value_json) VALUES (?, ?, ?, ?)', id, prop, typeId, JSON.stringify(item));
      facts += 1;
    }
  });
  const fieldReads = eeafFieldReads(sql);
  const answers = {};
  reads.forEach((read, index) => {
    const name = read?.name ?? String(index);
    if (typeof name !== 'string' || !name) throw new Error(`reads[${index}]: name is a non-empty string.`);
    if (Object.hasOwn(answers, name)) throw new Error(`reads[${index}]: the name ${JSON.stringify(name)} is given twice; name each read once.`);
    answers[name] = answerOf(read, index);
    answers[name].count = (answers[name].records ?? answers[name].ids).length;
  });
  function answerOf(read, index) {
    const op = read?.op;
    if (!OPS[op]) throw new Error(`reads[${index}] has op ${JSON.stringify(op)}; use one of ${Object.keys(OPS).join(', ')}.`);
    if (typeof read.type !== 'string' || !read.type) throw new Error(`reads[${index}] (${op}) needs type: the records' type.`);
    for (const need of OPS[op]) if (!(need in read)) throw new Error(`reads[${index}] (${op}) needs ${need}.`);
    const fields = read.fields ?? [];
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string' || !field)) throw new Error(`reads[${index}] (${op}): fields is a list of field names.`);
    if (op === 'fieldsOf') {
      if (!Array.isArray(read.ids)) throw new Error(`reads[${index}] (fieldsOf) needs ids: a list of record ids.`);
      return { op, type: read.type, records: [...fieldReads.fieldsOf(read.type, read.ids, fields).values()] };
    }
    if (op === 'after') return { op, type: read.type, records: fieldReads.after(read.type, read.field, read.after, fields, { limit: read.limit, after_id: read.after_id }) };
    if (op === 'newestPerGroup') return { op, type: read.type, records: fieldReads.newestPerGroup(read.type, { group: read.group, order: read.order, fields }) };
    return { op, type: read.type, ids: fieldReads.idsWhere(read.type, read.field, read.value, { limit: read.limit }) };
  }
  db.close();
  return { answers, held: { records: seen.size, facts }, left_out: leftOut };
}
