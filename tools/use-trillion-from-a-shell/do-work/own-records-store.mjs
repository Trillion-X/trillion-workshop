// tools/use-trillion-from-a-shell/do-work/own-records-store.mjs
//
// The person's own rows read and written in their plain SQLite file (trillion.json own_records_store.file) when no door answers
// `trillion op @own-records records:read | records:list | records:write`. The file is an ordinary database: one table per row type, an
// `id` column, a column per field most rows have and every other field as JSON in `extra`. Nothing here adds a layer to it: a row
// is read as its columns and its `extra`, and written back the same way.
//
// Table of a type: `record:<kind>` is the table <kind> and a bare `<kind>` is the table w_<kind> (every character that is not a letter
// or digit becomes _); the other name is tried when that one does not exist. A type with no table gets one (`id`, `extra`).
// A row read with no type is found by its id: the tables its id names first, then every table.
//
// The answers have the door's shapes: read {id, type, value}, list {records: [{id, type, value}], next}, write {accepted, records}.
import { DatabaseSync } from 'node:sqlite';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
const quote = name => `"${name.replaceAll('"', '""')}"`;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const sorted = value => (Array.isArray(value) ? value.map(sorted) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value);

/** The refusal of this store: `code` is the door's own word for it, so a caller reads the same codes at either. */
export class StoreRefusal extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** The text a field is kept as in a column, or null when it can only be kept exactly in `extra` (booleans, nulls, a string that is itself
 *  JSON, which reading would turn into an object). */
const columnText = value => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return /^\s*[[{]/.test(value) && parsed(value) !== undefined ? null : value;
  if (Array.isArray(value) || object(value)) return JSON.stringify(value);
  return null;
};
const parsed = text => { try { const value = JSON.parse(text); return value !== null && typeof value === 'object' ? value : undefined; } catch { return undefined; } };
const cell = value => (typeof value === 'string' && /^\s*[[{]/.test(value) ? parsed(value) ?? value : value);

export function openStore({ file, rules, open = path => new DatabaseSync(path) }) {
  const words = rules.words;
  const db = open(file);
  db.exec(`pragma busy_timeout = ${rules.busy_timeout_ms}`);
  let tables = null;
  const columns = new Map();
  const known = () => (tables ??= new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map(row => row.name)));
  const columnsOf = table => {
    if (!columns.has(table)) columns.set(table, db.prepare(`pragma table_info(${quote(table)})`).all().map(row => row.name));
    return columns.get(table);
  };
  const slug = kind => kind.replace(/[^A-Za-z0-9]+/g, '_');

  /** The tables a type may be, best first: `record:<kind>` is <kind>, a bare kind is w_<kind>, and the other is the second try. A name
   *  that is neither (a list's name, such as lessons-learned) is the type its list row declares (`row_type`, a record:<row_type>). */
  const tablesOf = (type, listed = false) => {
    const bare = !type.startsWith(rules.record_prefix);
    const kind = slug(bare ? type : type.slice(rules.record_prefix.length));
    const found = (bare ? [rules.bare_table_prefix + kind, kind] : [kind, rules.bare_table_prefix + kind]).filter(name => known().has(name));
    if (found.length || listed || !bare || !known().has(rules.list.table)) return found;
    const row = db.prepare(`select * from ${quote(rules.list.table)} where id = ?`).get(rules.list.id_prefix + type);
    const rowType = row ? valueOf(row, rules.list.table)[rules.list.type_field] : null;
    return typeof rowType === 'string' ? tablesOf(rules.record_prefix + rowType, true) : [];
  };
  /** The type a table's rows have when the caller did not name one. */
  const typeOf = table => (table.startsWith(rules.bare_table_prefix) ? table.slice(rules.bare_table_prefix.length) : rules.record_prefix + table).replaceAll('_', '-');
  /** The tables an id may be in, the ones its own prefix names first, then every other, one at a time so a hit stops the walk. */
  function* tablesNamedBy(id) {
    const named = id.startsWith(rules.record_prefix) ? id.slice(rules.record_prefix.length).split(':')[0] : id.split(':')[0];
    const seen = new Set();
    for (const table of [...tablesOf(rules.record_prefix + named), ...tablesOf(named), ...known()]) {
      if (seen.has(table) || !known().has(table)) continue;
      seen.add(table);
      if (columnsOf(table).includes('id')) yield table;
    }
  }

  const valueOf = (row, table) => {
    const value = {};
    for (const name of columnsOf(table)) {
      if (name === 'id' || name === rules.extra_column || row[name] === null || row[name] === undefined) continue;
      value[name] = cell(row[name]);
    }
    const extra = row[rules.extra_column];
    return extra ? { ...value, ...JSON.parse(extra) } : value;
  };
  /** The type a row answers as: the one asked when it names the table itself, else the table's own (a list's name is not a row type). */
  const typeAnswered = (type, table) => (type && tablesOf(type, true).includes(table) ? type : typeOf(table));
  const rowFor = (type, table, row, fields) => {
    const value = valueOf(row, table);
    return { id: row.id, type: typeAnswered(type, table), value: fields ? Object.fromEntries(fields.filter(name => name in value).map(name => [name, value[name]])) : value };
  };

  const find = (id, type) => {
    for (const table of type ? tablesOf(type) : tablesNamedBy(id)) {
      const row = db.prepare(`select * from ${quote(table)} where id = ?`).get(id);
      if (row) return { table, row };
    }
    return null;
  };

  const read = input => {
    if (typeof input.id !== 'string' || !input.id) throw new StoreRefusal(words.needs_id, 'records_invalid');
    const found = find(input.id, input.type);
    return found ? rowFor(input.type, found.table, found.row) : { id: input.id, type: input.type ?? null, value: null };
  };

  const list = input => {
    if (typeof input.type !== 'string' || !input.type) throw new StoreRefusal(words.needs_type, 'records_invalid');
    const [table] = tablesOf(input.type);
    if (!table) return { records: [], next: null };
    const limit = Math.min(Number.isInteger(input.limit) && input.limit > 0 ? input.limit : rules.list_default, rules.list_most);
    const clauses = [];
    const bound = [];
    const have = columnsOf(table);
    if (typeof input.prefix === 'string' && input.prefix) { clauses.push('id >= ? and substr(id, 1, ?) = ?'); bound.push(input.prefix, [...input.prefix].length, input.prefix); }
    for (const [key, sign] of [['after', '>'], ['above', '>'], ['below', '<']]) if (typeof input[key] === 'string') { clauses.push(`id ${sign} ?`); bound.push(input[key]); }
    for (const [key, wanted] of Object.entries(input.where ?? {})) {
      const left = have.includes(key) ? quote(key) : `json_extract(${quote(rules.extra_column)}, ?)`;
      if (!have.includes(key)) bound.push(`$.${quote(key)}`);
      const options = Array.isArray(wanted) ? wanted : [wanted];
      clauses.push(`${left} in (${options.map(() => '?').join(', ')})`);
      bound.push(...options.map(option => (typeof option === 'boolean' ? Number(option) : option)));
    }
    const rows = db.prepare(`select * from ${quote(table)}${clauses.length ? ` where ${clauses.join(' and ')}` : ''} order by id ${input.reverse === true ? 'desc' : 'asc'} limit ?`).all(...bound, limit + 1);
    const page = rows.slice(0, limit);
    return { records: page.map(row => rowFor(input.type, table, row, Array.isArray(input.fields) ? input.fields : null)), next: rows.length > limit ? page.at(-1).id : null };
  };

  const tableFor = type => {
    const [existing] = tablesOf(type);
    if (existing) return existing;
    const bare = !type.startsWith(rules.record_prefix);
    const name = (bare ? rules.bare_table_prefix : '') + slug(bare ? type : type.slice(rules.record_prefix.length));
    db.exec(`create table ${quote(name)}(id text, ${quote(rules.extra_column)} text)`);
    db.exec(`create index ${quote(`ix_${name}_id`)} on ${quote(name)}(id)`);
    tables.add(name);
    return name;
  };

  const keep = (table, id, value) => {
    const have = columnsOf(table);
    const cells = {};
    const extra = {};
    for (const [key, field] of Object.entries(value)) {
      const text = have.includes(key) && key !== 'id' && key !== rules.extra_column ? columnText(field) : null;
      if (text === null) extra[key] = field; else cells[key] = text;
    }
    const names = have.filter(name => name !== 'id' && name !== rules.extra_column);
    const extraText = Object.keys(extra).length ? JSON.stringify(extra) : null;
    const update = db.prepare(`update ${quote(table)} set ${[...names.map(name => `${quote(name)} = ?`), `${quote(rules.extra_column)} = ?`].join(', ')} where id = ?`)
      .run(...names.map(name => cells[name] ?? null), extraText, id);
    if (update.changes > 0) return;
    const set = [...names.filter(name => name in cells), rules.extra_column];
    db.prepare(`insert into ${quote(table)}(id, ${set.map(quote).join(', ')}) values (?, ${set.map(() => '?').join(', ')})`).run(id, ...set.slice(0, -1).map(name => cells[name]), extraText);
  };

  const write = input => {
    const items = input.records;
    if (!Array.isArray(items) || items.length < 1 || items.length > rules.write_most) throw new StoreRefusal(fill(words.write_count, { most: rules.write_most }), 'records_invalid');
    db.exec('begin immediate');
    try {
      const done = [];
      for (const item of items) {
        if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string' || !item.type || !('value' in item)) throw new StoreRefusal(words.write_shape, 'records_invalid');
        if (item.value !== null && !object(item.value)) throw new StoreRefusal(fill(words.write_value, { id: item.id }), 'records_invalid');
        const found = find(item.id, item.type);
        if ('expected' in item) {
          const held = found ? valueOf(found.row, found.table) : null;
          if (item.expected === null ? held !== null : !object(item.expected) || held === null || !same(item.expected.value, held)) throw new StoreRefusal(fill(words.expected_changed, { id: item.id }), 'records_expected_changed');
        }
        if (item.value === null) {
          if (found) db.prepare(`delete from ${quote(found.table)} where id = ?`).run(item.id);
        } else keep(found?.table ?? tableFor(item.type), item.id, item.value);
        done.push({ id: item.id, type: item.type });
      }
      db.exec('commit');
      return { accepted: true, pending: false, records: done };
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  };

  const methods = { read, list, write };
  return {
    answer: (method, input) => {
      const run = methods[Object.keys(rules.methods).find(name => rules.methods[name] === method)];
      if (!run) throw new StoreRefusal(fill(words.method, { method }), 'records_invalid');
      return run(input);
    },
    close: () => db.close(),
  };
}
