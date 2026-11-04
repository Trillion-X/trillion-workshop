// src/sql-writes.mjs
//
// Purpose: counts the writes a store's SQL handles make, per table, so a reader that keeps what it worked out from some
// tables (the scheduler's kept next-due times, src/scheduler-memo.mjs) learns that a table it read has changed by
// comparing one number, never by reading the table again.
//
// Non-Negotiable Invariants:
//   1. Every statement that may write is counted against the table it names (insert, replace, update, delete, drop,
//      alter, and the first create of a table in this instance), by the handles src/live-screen.mjs watchedSql wraps.
//   2. A statement this file cannot place (a write it does not recognise) counts against every reader: `revision`
//      includes the count of those, so an unplaced write can make a reader work again, never make it miss a change.
//   3. A count only goes up. A rolled-back transaction leaves its counts, so a reader works again after a rollback
//      it did not need to; it is never told nothing changed when something did.
//   4. Reads count nothing. A trigger's own writes to other tables are not seen: a reader of a table that triggers fill
//      names the table the trigger fires on as well.
//

const NAME = '("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const SCHEMA = `(?:${NAME}\\s*\\.\\s*)?`;
const WRITE = new RegExp(`^\\s*(?:insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+${SCHEMA}${NAME}`, 'i');
const CREATE = new RegExp(`^\\s*create\\s+(?:virtual\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${SCHEMA}${NAME}`, 'i');
const DROP = new RegExp(`^\\s*(?:drop\\s+table\\s+(?:if\\s+exists\\s+)?|alter\\s+table\\s+)${SCHEMA}${NAME}`, 'i');
// Statements that write no row of any table a reader reads.
const NO_ROWS = /^\s*(?:begin|commit|end|rollback|savepoint|release|vacuum|analyze|reindex|create\s+(?:unique\s+)?index|create\s+(?:temp(?:orary)?\s+)?(?:trigger|view)|drop\s+(?:index|trigger|view))\b/i;
const READS = /^\s*(?:select|pragma|explain)\b/i;
const WITH_WRITE = /^\s*with\b[\s\S]*\b(?:insert|update|delete|replace)\b/i;
// The table a WITH statement writes: the write that follows its last common table expression's closing parenthesis
// (src/record-tables.mjs puts a typed row as WITH source(...) AS (VALUES ...) INSERT INTO "rt_...").
const WITH_TARGET = new RegExp(`\\)\\s*(?:insert(?:\\s+or\\s+\\w+)?\\s+into|replace\\s+into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+${SCHEMA}${NAME}`, 'i');

// Values, quoted names and comments cannot introduce a second statement or a
// write verb. Unknown statements are treated as possible writes at a saving cap.
const SQL_QUOTED = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g;
const SQL_BINDING = /[:@$][A-Za-z_][\w$]*(?:::[\w$]+)*(?:\([^)]*\))?/g;
const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list',
  'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check', 'compile_options',
  'database_list', 'function_list', 'module_list', 'pragma_list', 'collation_list',
  'page_count', 'freelist_count', 'data_version', 'schema_version', 'user_version']);
const PARAMETERIZED_READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_info', 'index_xinfo',
  'index_list', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check']);

/** Whether a statement needs total_changes reconciliation, rather than only schema invalidation. */
export function sqlMayChangeRows(query) {
  if (!sqlMayWrite(query)) return false;
  const statements = String(query).replace(SQL_QUOTED, ' ').replace(SQL_BINDING, ' ').split(';').map(text => text.trim()).filter(Boolean);
  // Ordinary table and index definitions do not execute row changes. Keep CTAS, virtual tables, trigger bodies,
  // multi-statement writes and unknown SQL conservative. Budget and schema invalidation use sqlMayWrite separately.
  return statements.some(statement => {
    if (/^create\s+(?:(?:temp|temporary)\s+)?table\b/i.test(statement) && !/\bas\s+(?:select|with|values)\b/i.test(statement)) return false;
    if (/^create\s+(?:unique\s+)?index\b/i.test(statement)) return false;
    return sqlMayWrite(statement);
  });
}

/** Whether a trusted SQL statement may change stored rows or schema. */
export function sqlMayWrite(query) {
  const text = String(query);
  // A valid second SQL statement needs a semicolon. Common single reads need no
  // tokenization, irrespective of quoted text, comments or binding names.
  if (!text.includes(';') && /^\s*(?:select|values|explain)\b/i.test(text)) return false;
  const statements = text.replace(SQL_QUOTED, ' ').replace(SQL_BINDING, ' ').split(';').map(text => text.trim()).filter(Boolean);
  return statements.some(statement => {
    if (/^(?:select|values|explain|begin|commit|end|rollback|savepoint|release)\b/i.test(statement)) return false;
    if (/^with\b/i.test(statement)) return /\b(?:insert|update|delete)\b|\breplace\s+into\b/i.test(statement);
    const pragma = /^pragma\s+(?:[\w]+\s*\.\s*)?([\w]+)([\s\S]*)$/i.exec(statement);
    if (pragma && READ_PRAGMAS.has(pragma[1].toLowerCase())) {
      const argument = pragma[2].trim();
      if (!argument || (PARAMETERIZED_READ_PRAGMAS.has(pragma[1].toLowerCase()) && /^\([^()=]*\)$/.test(argument))) return false;
    }
    return true;
  });
}

const nameOf = text => (text.startsWith('"') || text.startsWith('`') || text.startsWith('[') ? text.slice(1, -1) : text).toLowerCase();

export function sqlWrites({strictSource = false} = {}) {
  const counts = new Map();
  const prefixCounts = new Map();
  const created = new Set();
  let unplaced = 0;
  const bump = table => {
    counts.set(table, (counts.get(table) ?? 0) + 1);
    for(const [prefix,count] of prefixCounts)if(table.startsWith(prefix))prefixCounts.set(prefix,count+1);
  };
  return {
    /** Counts what `query` may have written. */
    note(query) {
      // Source lifetime guards also depend on schema and connection policy.
      // Preserve the scheduler's ordinary no-row setup behavior by default.
      if(strictSource){
        if(!sqlMayWrite(query))return;
        if(!/^\s*(?:insert|replace|update|delete|with)\b/i.test(query)){unplaced+=1;return;}
      }
      // Several statements in one string are placed by none of the patterns below.
      if (query.includes(';') && /;\s*\S/.test(query.replace(/'(?:[^']|'')*'/g, "''"))) { unplaced += 1; return; }
      if (READS.test(query) || NO_ROWS.test(query)) return;
      if (/^\s*with\b/i.test(query) && !WITH_WRITE.test(query)) return;
      if (/^\s*with\b/i.test(query)) {
        const target = WITH_TARGET.exec(query);
        if (target) { bump(nameOf(target[2])); return; }
      }
      const written = WRITE.exec(query);
      if (written) { bump(nameOf(written[2])); return; }
      const made = CREATE.exec(query);
      if (made) {
        // A create that finds its table is no change; the first one in this instance may have made it.
        const table = nameOf(made[2]);
        if (!created.has(table)) { created.add(table); bump(table); }
        return;
      }
      const dropped = DROP.exec(query);
      if (dropped) { const table = nameOf(dropped[2]); created.delete(table); bump(table); return; }
      unplaced += 1;
    },
    /** Register bounded trusted prefix counters during paid source preparation. */
    preparePrefixes(prefixes) {
      const fresh=[...new Set(prefixes)].filter(prefix=>!prefixCounts.has(prefix));
      if(prefixCounts.size+fresh.length>32)throw new RangeError('At most32 SQL source prefixes may be observed per physical owner.');
      for(const prefix of fresh)prefixCounts.set(prefix,0);
    },
    /** One number that changes whenever a selected table/prefix is written, or a write was not placed. */
    revision(tables, prefixes = []) {
      let total = unplaced;
      for (const table of tables) total += counts.get(table) ?? 0;
      for(const prefix of prefixes){
        if(!prefixCounts.has(prefix))throw new TypeError('SQL source prefixes must be prepared before revision reads.');
        total+=prefixCounts.get(prefix);
      }
      return total;
    },
    /** One number that changes whenever any table was written, or a write was not placed: for a reader of state no one
     *  table names (a source whose time comes from many tables, facts and records). */
    all() {
      let total = unplaced;
      for (const count of counts.values()) total += count;
      return total;
    },
    /** The count of one table (for tests). */
    count: table => counts.get(table) ?? 0,
    unplaced: () => unplaced,
  };
}

/** The tables a statement reads, for the test that checks a source reads only the tables it says it does. */
export function tablesRead(query) {
  const found = new Set();
  const reading = new RegExp(`\\b(?:from|join)\\s+${SCHEMA}${NAME}`, 'gi');
  for (const match of query.matchAll(reading)) found.add(nameOf(match[2]));
  return [...found];
}

// Per-physical SQL owner, shared by every alias of its actual exec method.
// Install before the native host gives handles to domain owners. Final guards
// observe this existing table-write owner; they never query SQL after payment.
const observedSqlSources = new WeakMap();
export function observeSqlSource(sql) {
  if (!sql || typeof sql.exec !== 'function') throw new TypeError('An actual SQL source handle is required.');
  const kept = observedSqlSources.get(sql);
  if (kept) return kept;
  const original = sql.exec, writes = sqlWrites({strictSource:true});
  let incarnation = 0;
  const changed = () => Object.assign(new Error('The original SQL source changed after paid preparation.'), {status:410,code:'native_sql_source_changed'});
  const exec = function(query, ...bindings) {
    // Note before execution: failed writes and rollback conservatively revoke
    // prepared output. No domain onWrite notification is required or trusted.
    writes.note(query);
    return Reflect.apply(original, sql, [query, ...bindings]);
  };
  Object.defineProperty(sql, 'exec', {configurable:false, enumerable:false,
    get:()=>exec, set:()=>{incarnation++;throw new TypeError('The observed physical SQL exec cannot be replaced.');}});
  if (sql.exec !== exec) throw new TypeError('The physical SQL source cannot retain its observer.');
  const unavailable=(message,code='native_sql_source_schema_unavailable')=>Object.assign(new Error(message),{status:503,code});
  const identifier=value=>typeof value==='string'&&value.length<=128&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  const owner = Object.freeze({capture(selection) {
    const tables=Array.isArray(selection)?selection:selection?.tables??[],prefixes=Array.isArray(selection)?[]:selection?.prefixes??[];
    if(!Array.isArray(selection)&&(!selection||typeof selection!=='object'
      ||Object.keys(selection).some(key=>!['tables','prefixes'].includes(key))))
      throw new TypeError('A bounded native SQL table selection is required.');
    if(!Array.isArray(tables)||!Array.isArray(prefixes)||!tables.length&&!prefixes.length
      ||tables.length+prefixes.length>32||tables.some(table=>!identifier(table))||prefixes.some(prefix=>!identifier(prefix)))
      throw new TypeError('At most32 actual SQL source tables and identifier prefixes are required.');
    const selected=[],selectedSet=new Set(),matched=[...new Set(prefixes.map(prefix=>prefix.toLowerCase()))];
    try{
      // Workerd authorizes the table metadata owner rather than database_list.
      // Its schema rows also expose an attached schema even when it is empty.
      const foreignSchemas=sql.exec("SELECT 1 FROM pragma_table_list WHERE \"schema\"!='main' AND NOT (\"schema\"='temp' AND name='sqlite_temp_schema' AND type='table') LIMIT 1").toArray();
      if(foreignSchemas.length)
        throw unavailable('Native SQL source observation requires one physical main schema.');
      const add=name=>{
        if(!identifier(name))throw unavailable('The actual SQL source dependency has an unsupported identity.');
        name=name.toLowerCase();if(selectedSet.has(name))return;
        if(selected.length===32)throw unavailable('The actual SQL source dependency closure exceeds32 tables.','native_sql_source_dependency_bound');
        const found=sql.exec("SELECT name,type FROM sqlite_master WHERE lower(name)=? AND type IN ('table','view') LIMIT 2",name).toArray();
        const kinds=found.length===1?sql.exec('SELECT type FROM pragma_table_list WHERE "schema"=\'main\' AND lower(name)=? LIMIT 2',name).toArray():[];
        if(found.length!==1||found[0].type!=='table'||kinds.length!==1||kinds[0].type!=='table')
          throw unavailable('A selected SQL source must be an installed ordinary physical table; views, virtual and shadow tables require their actual dependency owner.','native_sql_source_table_unavailable');
        selectedSet.add(name);selected.push(name);
      };
      for(const table of tables)add(table);
      for(const prefix of matched){
        const found=sql.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND substr(lower(name),1,?)=? ORDER BY name LIMIT 33",prefix.length,prefix).toArray();
        if(found.length>32)throw unavailable('The actual SQL source prefix exceeds32 tables.','native_sql_source_dependency_bound');
        for(const row of found)add(row.name);
      }
      // Every trigger's direct source is conservative, including trigger chains.
      // No trigger body parser or caller-supplied dependency claim is trusted.
      const triggers=sql.exec("SELECT DISTINCT lower(tbl_name) AS name FROM sqlite_master WHERE type='trigger' ORDER BY name LIMIT 33").toArray();
      if(triggers.length>32)throw unavailable('The actual SQL trigger dependency closure exceeds32 tables.','native_sql_source_dependency_bound');
      for(const trigger of triggers)add(trigger.name);
      for(let at=0;at<selected.length;at++){
        const parents=sql.exec('SELECT DISTINCT lower("table") AS parent FROM pragma_foreign_key_list(?) ORDER BY parent LIMIT 33',selected[at]).toArray();
        if(parents.length>32)throw unavailable('The actual SQL foreign-key dependency closure exceeds32 tables.','native_sql_source_dependency_bound');
        for(const parent of parents)add(parent.parent);
      }
      try{writes.preparePrefixes(matched);}
      catch(error){throw Object.assign(unavailable('The physical SQL source prefix registry exceeds32 identities.','native_sql_source_prefix_bound'),{cause:error});}
    }catch(error){
      if(error?.status===503)throw error;
      throw Object.assign(unavailable('The actual native SQL dependency schema could not be inspected.'),{cause:error});
    }
    const revision=writes.revision(selected,matched), originalIncarnation=incarnation;
    return () => {
      if (sql.exec!==exec || incarnation!==originalIncarnation || writes.revision(selected,matched)!==revision) throw changed();
    };
  }});
  observedSqlSources.set(sql,owner);
  return owner;
}
