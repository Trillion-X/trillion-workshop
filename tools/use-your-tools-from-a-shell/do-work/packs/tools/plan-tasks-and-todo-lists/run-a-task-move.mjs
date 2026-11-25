// tools/plan-tasks-and-todo-lists/run-a-task-move.mjs
//
// The one caller of the task rows (task-moves.mjs) for anything that reaches a person's records through addressed
// operations: the shell command, the helper that takes work on a computer, a page. The rows read no store, so a
// call here (1) reads the records the move needs, (2) hands them in as `input.records` with tools:run, and (3) keeps
// every write the row answers (`keep`) with one records:write, each row conditioned on the value it was read at. A
// write refused because a record changed meanwhile is answered `{ kept: false, reason: 'changed' }`: the caller reads
// again and decides again. Nothing here decides who may do what; that is the rows' DATA.
//
//   runTaskMove(resource, { tool, input, key, read }) -> { result, kept, reason? }
//
// `resource(address, method, input, key)` is the caller's addressed transport. `read` says what to hand in:
//   { tasks: { where?, statuses? } }  every task in those stored status words (else every task), a page at a time
//   { ids: [{ type, id }] }           these records by id (the task named, its assignees, its continuation owner, a finish's consumer);
//                                     records:read takes the id, and `type` labels the record for a rule that names one
//   { types: [type] }                 every record of these types (whoever may take work, as the caller's settings name them)
// The bounds are the rows' own: at most `most` records are handed in (task-moves.json most_tasks_read).
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(readFileSync(new URL('./task-moves.json', import.meta.url), 'utf8'));
const RECORDS = '@own-records';
const TOOLS = '@tools';

// Every record of `type` (whose `where` fields equal), page after page, at most `most` of them. With `order`
// ({ field, direction }) only the first `most` in that order, in one call: a store that keeps the records in tables sorts them.
async function every(resource, type, where, most, pageSize, order = null, present = null, fields = null) {
  if (present) where = null;
  const only = { ...(present ? { present } : {}), ...(fields ? { fields } : {}) };
  if (order) {
    const page = await resource(RECORDS, 'records:list', { type, ...(where ? { where } : {}), ...only, limit: most, order });
    if (!Array.isArray(page?.records)) throw new Error(`The account did not return its ${type} records.`);
    return page.records.map(row => ({ id: row.id, type, value: row.value ?? null }));
  }
  const found = [];
  let after = null;
  do {
    const page = await resource(RECORDS, 'records:list', { type, ...(where ? { where } : {}), ...only, limit: Math.min(pageSize, most - found.length), ...(after ? { after } : {}) });
    if (!Array.isArray(page?.records)) throw new Error(`The account did not return its ${type} records.`);
    for (const row of page.records) found.push({ id: row.id, type, value: row.value ?? null });
    after = page.next ?? null;
  } while (after && found.length < most);
  return found;
}

/** The records one move needs, read through the caller's transport. */
export async function readFor(resource, read = {}, { rules = RULES } = {}) {
  const most = rules.most_tasks_read;
  const pageSize = rules.page_size ?? 100;
  const held = new Map();
  const add = rows => { for (const row of rows) if (!held.has(row.id)) held.set(row.id, row); };
  if (read.tasks) {
    const statuses = read.tasks.statuses ?? [null];
    // `newest` ({ field, direction, count }): only the first `count` of each status in that order, sorted by the store.
    // `fields`: only these fields of each task, for a row that reads them and writes none of these tasks.
    const order = read.tasks.newest ? { field: read.tasks.newest.field, direction: read.tasks.newest.direction } : null;
    for (const status of statuses) add(await every(resource, rules.task_kind, status === null ? read.tasks.where : { ...read.tasks.where, status }, order ? read.tasks.newest.count : most, pageSize, order, null, read.tasks.fields ?? null));
  }
  // A type is a record type, or { type, present }: only the records whose `present` fields hold a value.
  for (const one of read.types ?? []) {
    const { type, present = null } = typeof one === 'string' ? { type: one } : one;
    add(await every(resource, type, null, rules.most_people_read, pageSize, null, present));
  }
  // records:read answers the record's own value (the engine's read is the value, native-record-consumers.mjs), or null.
  for (const { type, id } of read.ids ?? []) {
    if (held.has(id)) continue;
    const value = await resource(RECORDS, 'records:read', { id });
    if (value !== null && value !== undefined) held.set(id, { id, type, value });
  }
  return [...held.values()];
}

// A store that keeps records as rows of tables (the runs-it database of whatever the work is for), as the same
// addressed transport runTaskMove reads and writes through: records:list, records:read and records:write over the tables
// `rows_in_tables` names, by one SQL statement each through `runSql(sql, params) -> rows`; any other operation goes to
// `rest` (the caller's own transport, for tools:run). A record's value is its row's named columns and the fields of
// its `rest` column. A list may also name `matching`: alternatives, a record fitting any one of them is listed, so the
// store hands over only the records a caller may act on (see `reach` below). A write is one statement conditioned on the row as it was read (a new record only where none has its
// id), so of two writers of one row only the first changes it; a refused write is the conflict runTaskMove reads again on.
const NAME = /^[a-z_][a-z0-9_]*$/;
const named = name => { if (!NAME.test(name)) throw new Error(`"${name}" is not a plain table or column name.`); return name; };
const changedError = () => Object.assign(new Error('original_command_conflict: the row changed since it was read.'), { code: 'original_command_conflict' });

export function recordsInTables(runSql, { rest, rules = RULES } = {}) {
  const tables = new Map(rules.rows_in_tables.tables.map(table => {
    for (const column of [table.table, table.rest, ...table.columns]) named(column);
    return [table.type, table];
  }));
  const valueOf = (table, row) => {
    const value = { ...((table.rest && row[table.rest]) ?? {}) };
    for (const column of table.columns) if (row[column] !== null && row[column] !== undefined) value[column] = row[column];
    return value;
  };
  // The row a value is kept as: each named column (null when the value has no such field) and the rest of its fields.
  const rowOf = (table, value) => {
    const row = { [table.rest]: {} };
    for (const column of table.columns) row[column] = value?.[column] ?? null;
    for (const [field, cell] of Object.entries(value ?? {})) if (!table.columns.includes(field)) row[table.rest][field] = cell;
    return row;
  };
  const cast = (table, column, at) => (table.json.includes(column) || column === table.rest ? `$${at}::jsonb` : `$${at}::text`);
  const cell = (table, column, cellValue) => (table.json.includes(column) || column === table.rest ? (cellValue === null ? null : JSON.stringify(cellValue)) : (cellValue === null ? null : String(cellValue)));
  // The row as it was read, as one JSON object of the kept columns, so a condition compares it whole.
  const keptObject = table => `jsonb_build_object(${[...table.columns, table.rest].map(column => `'${column}', ${column === table.rest ? `coalesce(${column}, '{}'::jsonb)` : column}`).join(', ')})`;
  const tableOf = type => { const table = tables.get(type); if (!table) throw new Error(`No table keeps records of type ${type} (task-moves.json rows_in_tables).`); return table; };

  // `matching` is a list of alternatives; an alternative is { <field path>: <test> }, every test of it holding for the
  // record to fit it (an empty alternative fits every record, an empty list fits none). A field path is a field of the
  // record's value as the caller reads it: a column, or a field of the rest column, dotted into JSON ('told_as.source').
  // A test is exactly one of { in: [values] } (the field's text is one of them), { contains: value } (the JSON field
  // contains that JSON: an array holding it) and { holds: true | false } (the field holds something: it is not absent, null,
  // empty text, [] or {}). Names are checked as plain names, so no SQL text of a caller's reaches the statement.
  const NOTHING = ["'null'::jsonb", `'""'::jsonb`, "'[]'::jsonb", "'{}'::jsonb"].join(', ');
  const fieldOf = (table, path) => {
    const [head, ...more] = String(path).split('.').map(named);
    const column = table.columns.includes(head) ? head : table.rest;
    const steps = column === head ? more : [head, ...more];
    const json = column === table.rest || table.json.includes(column);
    if (!json && steps.length) throw new Error(`${path} goes into ${column}, which holds text.`);
    return { json, steps: steps.length ? `'{${steps.join(',')}}'` : null, column };
  };
  const testOf = (table, path, test, params) => {
    const field = fieldOf(table, path);
    const kinds = Object.keys(test ?? {});
    if (kinds.length !== 1 || !['in', 'contains', 'holds'].includes(kinds[0])) throw new Error(`matching: ${path} needs exactly one of in, contains or holds.`);
    const jsonb = field.steps ? `${field.column} #> ${field.steps}` : field.column;
    const text = field.json ? `${field.steps ? `${field.column} #>> ${field.steps}` : `${field.column} #>> '{}'`}` : field.column;
    if (kinds[0] === 'in') {
      if (!Array.isArray(test.in)) throw new Error(`matching: ${path} in must be a list.`);
      params.push(JSON.stringify(test.in.map(String)));
      return `${text} = any (select jsonb_array_elements_text($${params.length}::jsonb))`;
    }
    if (kinds[0] === 'contains') {
      if (!field.json) throw new Error(`matching: ${path} holds text, which contains nothing.`);
      params.push(JSON.stringify(test.contains));
      return `${jsonb} @> $${params.length}::jsonb`;
    }
    if (typeof test.holds !== 'boolean') throw new Error(`matching: ${path} holds must be true or false.`);
    const holds = field.json ? `(${jsonb} is not null and ${jsonb} not in (${NOTHING}))` : `(${field.column} is not null and ${field.column} <> '')`;
    return test.holds ? holds : `not ${holds}`;
  };
  const matchingSql = (table, matching, params) => `(${matching.map(alternative => {
    const tests = Object.entries(alternative ?? {}).map(([path, test]) => testOf(table, path, test, params));
    return tests.length ? `(${tests.join(' and ')})` : 'true';
  }).join(' or ')})`;

  async function list({ type, where = {}, limit = 100, after = null, order = null, present = [], fields = null, matching = null }) {
    const table = tableOf(type);
    if (matching !== null && !Array.isArray(matching)) throw new Error('matching must be a list of alternatives.');
    if (matching?.length === 0) return { records: [], next: null };
    // Only the named fields that are columns (a field kept in the rest column is not read when fields are named).
    const kept = fields ? { ...table, columns: table.columns.filter(column => fields.includes(column)), rest: null } : table;
    for (const field of present) if (!table.columns.includes(named(field))) throw new Error(`${field} is not a column of ${table.table}.`);
    if (order && after) throw new Error('A list in an order is read in one call: it takes no `after`.');
    if (order && !table.columns.includes(named(order.field))) throw new Error(`${order.field} is not a column of ${table.table}.`);
    const sorted = order ? `${order.field} ${order.direction === 'desc' ? 'desc' : 'asc'} nulls last, id ${order.direction === 'desc' ? 'desc' : 'asc'}` : 'id';
    const params = [];
    const conditions = Object.entries(where).map(([column, want]) => { params.push(cell(table, named(column), want)); return `${column} = ${cast(table, column, params.length)}`; });
    for (const field of present) conditions.push(`${field} is not null`);
    if (matching) conditions.push(matchingSql(table, matching, params));
    if (after) { params.push(after); conditions.push(`id > $${params.length}::text`); }
    params.push(order ? limit : limit + 1);
    const rows = await runSql(`select ${['id', ...kept.columns, ...(kept.rest ? [kept.rest] : [])].join(', ')} from ${table.table}${conditions.length ? ` where ${conditions.join(' and ')}` : ''} order by ${sorted} limit $${params.length}`, params);
    const page = rows.slice(0, limit);
    return { records: page.map(row => ({ id: row.id, value: valueOf(kept, row) })), next: rows.length > limit ? page[page.length - 1].id : null };
  }
  async function read({ id }) {
    for (const table of tables.values()) {
      const [row] = await runSql(`select id, ${[...table.columns, table.rest].join(', ')} from ${table.table} where id = $1::text`, [id]);
      if (row) return valueOf(table, row);
    }
    return null;
  }
  async function write({ records }) {
    for (const { id, type, value, expected } of records) {
      const table = tableOf(type);
      const columns = [...table.columns, table.rest];
      let rows;
      if (expected === null || expected === undefined) {
        const row = rowOf(table, value);
        const params = [id, ...columns.map(column => cell(table, column, row[column]))];
        const stamps = [table.made_at, table.changed_at].filter(Boolean).map(named);
        rows = await runSql(`insert into ${table.table} (id, ${[...columns, ...stamps].join(', ')}) values ($1::text, ${columns.map((column, at) => cast(table, column, at + 2)).join(', ')}${stamps.map(() => ', now()').join('')}) on conflict (id) do nothing returning id`, params);
      } else {
        const was = JSON.stringify(rowOf(table, expected.value));
        if (value === null) {
          rows = await runSql(`delete from ${table.table} where id = $1::text and ${keptObject(table)} = $2::jsonb returning id`, [id, was]);
        } else {
          const row = rowOf(table, value);
          const params = [id, was, ...columns.map(column => cell(table, column, row[column]))];
          const stamp = table.changed_at ? `, ${named(table.changed_at)} = now()` : '';
          rows = await runSql(`update ${table.table} set ${columns.map((column, at) => `${column} = ${cast(table, column, at + 3)}`).join(', ')}${stamp} where id = $1::text and ${keptObject(table)} = $2::jsonb returning id`, params);
        }
      }
      if (!rows.length) throw changedError();
    }
    return { written: records.length };
  }
  return async (address, method, input, key) => {
    if (address === RECORDS && method === 'records:list') return list(input);
    if (address === RECORDS && method === 'records:read') return read(input);
    if (address === RECORDS && method === 'records:write') return write(input);
    if (!rest) throw new Error(`${method} at ${address} has no transport here.`);
    return rest(address, method, input, key);
  };
}

/** The declared states the rules name (every `states` key). */
export const declaredStates = (rules = RULES) => rules.states.map(state => state.key);
/** The state a stored status word means: itself, or what `read_as` maps it to. */
export const stateOfWord = (word, rules = RULES) => rules.read_as?.[word] ?? word;
/** Every stored word that means one of these states: each state itself and each `read_as` word that maps to it. */
export function wordsOfStates(states, rules = RULES) {
  const words = new Set(states);
  for (const [word, state] of Object.entries(rules.read_as ?? {})) if (states.includes(state)) words.add(word);
  return [...words];
}
/** The states an action moves a task out of (its transitions' `from`), so a listing reads every task it may move. */
export const statesFrom = (action, rules = RULES) => [...new Set(rules.transitions.filter(edge => edge.action === action).map(edge => edge.from))];

/** One task row run over the records it needs, its writes kept where they were read. */
/** What a tool said on its error output: the `error` of the JSON it wrote there, else the text itself. */
function saidIn(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { const said = JSON.parse(text); return typeof said?.error === 'string' ? said.error : text.trim(); } catch { return text.trim(); }
}

/** One tool run to its answer: tools:run, read again while it is still running. Answers the tool's own result. */
async function toolResult(resource, tool, input, key, { reads = 5, waitSeconds = 10 } = {}) {
  let answer = await resource(TOOLS, 'tools:run', { tool, input }, key);
  for (let attempt = 0; answer?.task_id && !['completed', 'failed'].includes(answer.state) && attempt < reads; attempt += 1) {
    answer = await resource(TOOLS, 'tools:read', { task_id: answer.task_id, wait_seconds: waitSeconds });
  }
  // A tool that answers with its own refusal (a rule that does not allow the move) is said as that refusal, code tool_refused.
  if (answer?.state === 'failed' || (answer?.exit_code && answer.exit_code !== 0)) throw Object.assign(new Error(saidIn(answer.error) ?? saidIn(answer.stderr) ?? `${tool} failed.`), { code: 'tool_refused' });
  if (answer?.task_id && answer.state !== 'completed') throw new Error(`${tool} is still running; its request key ${key} reads it again.`);
  const output = answer?.output ?? answer;
  return output?.result ?? output;
}

/** The transport task moves go through for a store: `store` names the held connection of the database whose tables keep
 *  the records (`{ credential_name }`), and each statement is one run of the rules' `rows_in_tables.sql_tool` through
 *  `resource`; with no store, `resource` itself (an account whose records door keeps them). */
export function tasksIn(resource, store, { rules = RULES } = {}) {
  if (!store?.credential_name) return resource;
  const tool = rules.rows_in_tables.sql_tool;
  const runSql = async (sql, params) => {
    const answer = await toolResult(resource, tool, { credential_name: store.credential_name, sql, params });
    if (!Array.isArray(answer?.rows)) throw new Error(`${tool} answered no rows: ${String(answer?.error ?? JSON.stringify(answer)).slice(0, 300)}`);
    return answer.rows;
  };
  return recordsInTables(runSql, { rest: resource, rules });
}

export async function runTaskMove(resource, { tool, input = {}, key, read = {}, rules = RULES, reads = 5, waitSeconds = 10 }) {
  const records = await readFor(resource, read, { rules });
  const result = await toolResult(resource, tool, { ...input, records }, key, { reads, waitSeconds });
  const keep = Array.isArray(result?.keep) ? result.keep : [];
  if (!keep.length) return { result, kept: true };
  try {
    await resource(RECORDS, 'records:write', { records: keep }, key && `${key}:keep`);
  } catch (error) {
    if (error?.code === 'original_command_conflict' || String(error?.message ?? '').includes('original_command_conflict')) return { result, kept: false, reason: 'changed' };
    throw error;
  }
  return { result, kept: true };
}
