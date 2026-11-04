// parts/eeaf/do-work/eeaf-field-reads.mjs
//
// Purpose: named top-level fields of many records of one type, read straight from the attribute facts the EEAF store
// keeps (do-work/eeaf-sqlite-store.mjs), without assembling a single record. A question over every record of a kind
// (how many arrived this week, the newest per place, which ones name this message) then costs the few fields it asks
// about, never each whole record: `read(id)` assembles a record from four queries and every field it holds, which over
// thousands of records is the whole kind in memory at once.
//
// Non-Negotiable Invariants:
//   1. Only a root record's own top-level fields are read (the facts on the root's subject, property `prop:<type>:<field>`);
//      a field that holds an object or a list lives on child subjects and is not answered here.
//   2. What is answered is what the store holds now: a removed record has no facts, so it is never answered.
//   3. Values come back decoded from their JSON; `after` and the ordering compare the kept JSON text, so they order
//      correctly for values of one shape that sort as text (ISO times, zero-padded numbers).
//   4. Every read is bounded by what it is asked for: the ids given, the records after a value, or one row per group.
//   5. The field names come from the caller's code, never from a person; each is bound as a parameter, never spliced.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const propertyId = (type, field) => `prop:${type}:${field}`;
const decode = text => (text === null || text === undefined ? null : JSON.parse(text));

// sql: the same SQLite handle the EEAF store was made with (`exec(query, ...params).toArray()`).
export function eeafFieldReads(sql, read = null, readSelected = null) {
  const all = (query, ...params) => sql.exec(query, ...params).toArray();
  // { id → { field: value } } for the subjects in `rows` ({ subject_id, property_id, value_json }).
  const gather = (type, fields, rows, ids) => {
    const byProperty = new Map(fields.map(field => [propertyId(type, field), field]));
    const found = new Map(ids.map(id => [id, { id }]));
    for (const row of rows) {
      const record = found.get(row.subject_id);
      const field = byProperty.get(row.property_id);
      if (record && field) record[field] = decode(row.value_json);
    }
    return found;
  };
  const fieldsOfIds = (type, ids, fields) => {
    if (!ids.length) return new Map();
    // Start with the requested IDs/properties. CROSS JOIN fixes that small-input
    // order. Pin the declared primary key: SQLite otherwise prefers a covering
    // property index even in that order, scanning unrelated subjects. This uses
    // the existing subject/property primary key instead of
    // scanning every record's values through a property-first index.
    const selected = [...new Set(ids)];
    const properties = [...new Set(fields.map(field => propertyId(type, field)))];
    // reads-ok: O(requested IDs × requested fields) through the declared primary key; actual Workerd fixed seven-row reads stay 112 at 256/1024 history.
    const rows = all(`SELECT facts.subject_id, facts.property_id, facts.value_json
      FROM json_each(?) selected CROSS JOIN json_each(?) properties CROSS JOIN attribute_fact facts INDEXED BY sqlite_autoindex_attribute_fact_1
      WHERE facts.subject_id = selected.value AND facts.property_id = properties.value`,
      JSON.stringify(selected), JSON.stringify(properties));
    const found = gather(type, fields, rows, ids);
    // An id the store does not hold as this type answers nothing.
    // reads-ok: O(requested IDs), one existing type membership seek per selected ID.
    const held = new Set(all(`SELECT types.entity_id FROM json_each(?) selected CROSS JOIN entity_types types
      WHERE types.entity_id = selected.value AND types.type_id = ?`, JSON.stringify(selected), `type:${type}`).map(row => row.entity_id));
    return new Map([...found].filter(([id]) => held.has(id)));
  };

  return {
    // Positive selected-field assembly omits unrequested subtrees. Older callers retain their complete reader.
    projectOf(type, ids, { fields: names = [], presence: paths = [] } = {}) {
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !name)) throw new Error('Projection must name fields');
      if (!Array.isArray(paths) || paths.some(path => !Array.isArray(path) || !path.length || path.some(field => typeof field !== 'string' || !field))) throw new Error('Presence must name nonempty field paths');
      const unique = [...new Set(ids)];
      if (!unique.length) return new Map();
      if (!read) throw new Error('Field projection needs the record reader');
      const held = fieldsOfIds(type, unique, []);
      return new Map(unique.filter(id => held.has(id)).map(id => {
        const parents = [...new Set([...names,...paths.map(path=>path[0])])];
        const value = readSelected ? readSelected(id,parents) : read(id), selected = { id };
        for (const name of new Set(names)) if (value[name] !== undefined) selected[name] = value[name];
        return [id, { fields: selected, presence: paths.map(path => {
          let item = value;
          for (const field of path) { if (item === null || item === undefined) return false; item = item[field]; }
          return item !== undefined;
        }) }];
      }));
    },
    presenceOf(type, ids, paths) {
      return new Map([...this.projectOf(type, ids, { presence: paths })].map(([id, value]) => [id, value.presence]));
    },
    /** `{ id → { id, ...fields } }` of the records of `type` among `ids`; an id not held as that type is left out. */
    fieldsOf(type, ids, fields) {
      return fieldsOfIds(type, [...new Set(ids)], fields);
    },
    /** `[{ id, ...fields }]` of the records of `type` whose `field` is after `after` (compared as kept), oldest first;
     *  with `limit`, at most that many, so a reader that keeps its place reads a page at a time.
     *  `after_id` resumes the exact (value, id) pair in the existing index; without it
     *  the bound remains strictly after the scalar value, as before. */
    after(type, field, after, fields = [], { limit, after_id } = {}) {
      if (after_id !== undefined && (typeof after_id !== 'string' || !after_id || after_id.includes('\u0000') || after === undefined)) {
        throw new Error('after_id needs an exclusive value and record id.');
      }
      const page = Number.isInteger(limit) && limit > 0 ? limit : -1;
      // The existing (property_id, value_json, subject_id) index seeks directly past the pair.
      // No equal-group scan or schema preparation is needed in a question.
      const ids = (after_id === undefined
        ? all('SELECT subject_id FROM attribute_fact WHERE property_id = ? AND value_json > ? ORDER BY value_json LIMIT ?', propertyId(type, field), JSON.stringify(after), page)
        : all('SELECT subject_id FROM attribute_fact WHERE property_id = ? AND (value_json, subject_id) > (?, ?) ORDER BY value_json, subject_id LIMIT ?', propertyId(type, field), JSON.stringify(after), after_id, page)).map(row => row.subject_id);
      const found = fieldsOfIds(type, ids, [...new Set([field, ...fields])]);
      return ids.map(id => found.get(id)).filter(Boolean);
    },
    /** `[{ id, ...fields }]`: for each value of `group`, the record of `type` whose `order` is largest (compared as kept). */
    newestPerGroup(type, { group, order, fields = [] }) {
      const ids = all(`SELECT subject_id FROM (SELECT g.subject_id, g.value_json AS grouped, o.value_json AS ordered,
          ROW_NUMBER() OVER (PARTITION BY g.value_json ORDER BY o.value_json DESC, g.subject_id DESC) AS place
        FROM attribute_fact g JOIN attribute_fact o ON o.subject_id = g.subject_id AND o.property_id = ?
        WHERE g.property_id = ?) WHERE place = 1`, propertyId(type, order), propertyId(type, group)).map(row => row.subject_id);
      const found = fieldsOfIds(type, ids, [...new Set([group, order, ...fields])]);
      return ids.map(id => found.get(id)).filter(Boolean);
    },
    /** The ids of the records of `type` whose `field` holds exactly `value`, in id order; the first `limit` when given. */
    idsWhere(type, field, value, { limit } = {}) {
      return all(`SELECT a.subject_id FROM attribute_fact a JOIN entity_types t ON t.entity_id = a.subject_id AND t.type_id = ? WHERE a.property_id = ? AND a.value_json = ? ORDER BY a.subject_id${Number.isFinite(limit) ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ''}`,
        `type:${type}`, propertyId(type, field), JSON.stringify(value)).map(row => row.subject_id);
    },
  };
}
