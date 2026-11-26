import { realpathSync } from 'node:fs';
// tools/run-sql-in-my-database/do-work/run-sql.mjs
//
// The container tool `tool:run-sql-in-my-database` (tool-rows.json): one SQL statement, as written, in the person's own
// Postgres-wire database, answered as { columns, rows, row_count } or the database's own error text: the caller's `sql`
// (with `params`). It makes no table of its own: a list is a table the person's AI makes in the database's own language.
//
// The connection string is a held value the engine hands this one process on a private pipe, descriptor 3 (the row's
// invoke.credential_mounts); it is never in the request, argv, a file or the environment, and no answer or error holds it.
// This file reads no vault and names no vendor or host: any server that speaks the Postgres wire protocol answers it.
// One statement per call is the protocol's rule, not ours: every statement goes through the extended query protocol (a named
// prepared statement), which the server refuses when the text holds more than one command. What a login may do is that
// login's rule in the database (a SELECT-only role cannot write); nothing here checks it, wraps it or adds a flag.
//
// A third shape runs several statements in one transaction that ends in a rollback unless it says commit ({ statements:
// [{ sql, params }], then }): each statement behind its own savepoint, so a refused one answers the database's words and the
// rest still run, and a trial of writes answers its reads while the database keeps nothing.
//
// A second shape runs a role recipe (read-data/role-recipes.json) as the connection's login: { recipe: { name, action, role?,
// valid_until?, limits? } }. `create` with a held role connection (role_credential_name, handed on descriptor 4) makes that standing
// login with the password the person holds; `create` with a password_verifier makes a login for someone else whose password
// only they hold (they send the SCRAM verifier made from it, never the password: do-work/make-a-login-verifier.mjs); `create`
// with valid_until and no held one mints a login that stops working then, and answers it once; `drop` takes a role away. Every value goes into the recipe's SQL through the server's own format().
// A recipe that adds rows (`adds_rows`) also takes { table, columns, fixed }: the one table, the columns the login may name and the
// values the server sets on every row it adds.
// A recipe that grants per table (`per_table`, may-read-under-row-rules) also takes { tables: ['schema.table', ...] }: each named
// table, and USAGE on its schema, and nothing else in that schema (a schema's other tables may hold rows no row rule guards).
// Named tables also mean no whole-public read: the public_grants block (every public table) is given only when no tables are named.
// A recipe that grants per write (`per_write`, may-write-named-columns-under-a-use) takes { writes: [{ table, select?, insert?,
// update?, delete?, rows?, keeps_out? } | { function }] }: each right an entry names, on exactly the columns it names, and nothing it
// does not name. An entry's `rows: { key }` limits the login to the rows whose key column holds the digest of a key its run presented
// after claiming its use (use_binding.present_key), and `keeps_out` to writes that put no value under the named jsonb keys: one
// restrictive row rule for the login, written by the server.
// A recipe runs in one transaction unless it says `in_one_transaction: false`: Postgres runs CREATE DATABASE and DROP
// DATABASE only outside a transaction block, so such a recipe's statements run one by one on the same connection.
// A recipe that takes a held value (`takes_held_value`) is handed it on descriptor 6 (value_credential_name) and fills it in
// as %10$L, so a value no caller holds (a database's use key) reaches the database without passing through the request.
//
// A statement under a declared use ({ sql, use: { purpose, surface } }, database given) is run by the database's reader
// login with the ticket the engine signed for that use on descriptor 5 (the engine's use_ticket.rs): the
// statement's own transaction first claims the ticket (use_binding.claim_use, role recipe may-read-under-row-rules), which
// binds the use to that transaction once, so the row rules read it and nothing the statement does can change it. A use with
// no ticket is refused here: only the engine binds a use.
//
// Every connection ends its own statements and open transactions server-side at what is left of the run
// (read-data/time-limits.json, the row's invoke.max_run_ms): the engine kills this process at its ceiling, but a statement
// it had sent runs on in the database unless the database itself is told when to stop.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { throughProxy } from './through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const ROLE_CONNECTION_DESCRIPTOR = 4;
const TICKET_DESCRIPTOR = 5;
const HELD_VALUE_DESCRIPTOR = 6;
// 32 random bytes written as base64url are 43 characters; a standing login's password shorter than that is refused.
const MIN_PASSWORD_LENGTH = 43;
// A SCRAM-SHA-256 verifier as Postgres keeps one (RFC 5803): iterations, salt, StoredKey and ServerKey. The server takes it as the
// role's password unchanged, so the password itself never reaches this computer. Fewer than 4096 iterations is refused.
const VERIFIER = /^SCRAM-SHA-256\$(\d+):[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const RECIPES = JSON.parse(readFileSync(new URL('../read-data/role-recipes.json', import.meta.url), 'utf8')).recipes;
const TIME_LIMITS = JSON.parse(readFileSync(new URL('../read-data/time-limits.json', import.meta.url), 'utf8'));
const ROW = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records
  .map(record => record.payload).find(payload => payload?.id === 'tool:run-sql-in-my-database');

const rowAddingRecipes = Object.keys(RECIPES).filter(name => RECIPES[name].adds_rows === true);
const perTableRecipes = Object.keys(RECIPES).filter(name => RECIPES[name].per_table !== undefined);
const perWriteRecipes = Object.keys(RECIPES).filter(name => RECIPES[name].per_write !== undefined);
// The column rights a writes entry may name, and a function as schema.name(argument types).
const FUNCTION_NAME = /^[^.\s]+\.[^.\s(]+\([^()]*\)$/;
// A named table is schema.table: two identifiers, each without a dot or a space.
const TABLE_NAME = /^[^.\s]+\.[^.\s]+$/;

const held = descriptor => {
  try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; }
};

// One statement through the extended protocol; the answer is the columns, the rows and the rows' count.
let sent = 0;
const runOne = async (client, text, values = []) => {
  const result = await client.query({ name: `statement_${sent += 1}`, text, values });
  return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.rowCount ?? result.rows.length };
};

// The use a step declares for its statement ({ purpose, surface }, text): absent means no use is bound.
const usedOf = use => {
  if (use === undefined) return undefined;
  if (use === null || typeof use !== 'object' || Array.isArray(use) || Object.keys(use).length !== 2
    || typeof use.purpose !== 'string' || typeof use.surface !== 'string') throw new Error('use must be { purpose, surface }, two text values.');
  return { purpose: use.purpose, surface: use.surface };
};

// One statement inside a transaction that first claims the run's use ticket: the database checks the engine's signature and
// the ticket's end, and binds its use to this transaction alone, so the row rules read this statement's use and nothing else.
const runUnderTicket = async (client, shape, ticket) => {
  await runOne(client, 'BEGIN');
  try {
    await runOne(client, 'SELECT * FROM use_binding.claim_use($1)', [ticket]);
    const answer = await runOne(client, shape.sql, shape.params);
    // A named fence table is read in the same transaction as the claim: whether it has row rules, the purpose this use claimed,
    // and whether the login may read it at all (use_binding.fenced, role recipe may-read-under-row-rules).
    if (shape.fence !== undefined) {
      const { rows: [fence] } = await runOne(client, 'SELECT fenced, claimed_purpose, allowed FROM use_binding.fenced($1::regclass)', [shape.fence]);
      answer.fence = fence;
    }
    await runOne(client, 'COMMIT');
    return answer;
  } catch (error) {
    await runOne(client, 'ROLLBACK').catch(() => {});
    throw error;
  }
};

// Several statements in one transaction, in order, each behind its own savepoint: a statement the database refuses answers
// { error } with the database's own text and the next statement still runs, so a run of expected refusals reads in one call.
// The transaction then ends as `then` says: rollback (the default) keeps nothing the statements did, so writes can be tried
// and their reads answered without changing the database; commit keeps it. Under a use, the transaction claims the ticket first.
// The answer keeps the one answer shape: one row per statement, in order ({ statement, columns, rows, row_count } or
// { statement, error }), and `refused`, how many the database refused.
const MAX_STATEMENTS = 200;
const runInOneTransaction = async (client, shape, ticket) => {
  await runOne(client, 'BEGIN');
  try {
    if (ticket) await runOne(client, 'SELECT * FROM use_binding.claim_use($1)', [ticket]);
    const rows = [];
    for (const [statement, { sql, params }] of shape.statements.entries()) {
      await runOne(client, 'SAVEPOINT each_statement');
      try {
        rows.push({ statement, ...await runOne(client, sql, params) });
        await runOne(client, 'RELEASE SAVEPOINT each_statement');
      } catch (error) {
        await runOne(client, 'ROLLBACK TO SAVEPOINT each_statement');
        rows.push({ statement, error: error.message });
      }
    }
    await runOne(client, shape.then === 'commit' ? 'COMMIT' : 'ROLLBACK');
    return { columns: ['statement', 'columns', 'rows', 'row_count', 'error'], rows, row_count: rows.length, then: shape.then, refused: rows.filter(row => row.error !== undefined).length };
  } catch (error) {
    await runOne(client, 'ROLLBACK').catch(() => {});
    throw error;
  }
};

// The names a request gives for its connection: credential_name (the held connection) or database (one of the person's
// databases). An absent, null or empty name is not given: the engine mounts the connection only for a request that names one.
export const namesTarget = input => ['credential_name', 'database'].some(name => input?.[name] !== undefined && input[name] !== null && input[name] !== '');

// A per-table recipe's tables: each schema.table (the whole table) or { table: schema.table, columns: [...] } (only those columns).
const tablesOf = tables => {
  if (!Array.isArray(tables)) throw new Error('recipe.tables must be a list of schema.table names, or { table, columns } entries.');
  return tables.map((entry, index) => {
    const { table, columns } = typeof entry === 'string' ? { table: entry, columns: null } : (entry !== null && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).every(key => key === 'table' || key === 'columns') ? entry : {});
    if (typeof table !== 'string' || !TABLE_NAME.test(table)) throw new Error(`recipe.tables must be a list of schema.table names, one each, or { table: schema.table, columns: [...] } entries: recipe.tables[${index}] is neither.`);
    if (table.startsWith('use_binding.')) throw new Error('recipe.tables may not name the use_binding schema: its keys and claims are the login\'s to call into, never to read.');
    if (columns !== null && (!Array.isArray(columns) || columns.length === 0 || columns.some(column => typeof column !== 'string' || column === ''))) throw new Error(`recipe.tables[${index}].columns must be a list of column names.`);
    return { table, columns };
  });
};

// A per-write recipe's writes: each entry a table with the column rights it names (and delete: true), or one function.
const writesOf = (name, writes) => {
  if (RECIPES[name].per_write === undefined) throw new Error(`recipe.writes is for a recipe that grants per write (${perWriteRecipes.join(', ')}), not ${name}.`);
  if (!Array.isArray(writes) || writes.length === 0) throw new Error('recipe.writes must be a list of { table, select?, insert?, update?, delete? } or { function } entries.');
  for (const [index, entry] of writes.entries()) {
    const at = `recipe.writes[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object.`);
    if (Object.hasOwn(entry, 'function')) {
      if (Object.keys(entry).length !== 1 || typeof entry.function !== 'string' || !FUNCTION_NAME.test(entry.function)) throw new Error(`${at} must be { function: 'schema.name(argument types)' } alone.`);
      if (entry.function.startsWith('use_binding.')) throw new Error(`${at} may not name the use_binding schema: the recipe gives its claim and nothing else there.`);
      continue;
    }
    const unknown = Object.keys(entry).filter(key => !['table', ...COLUMN_RIGHTS, 'delete', 'rows', 'keeps_out'].includes(key));
    if (unknown.length) throw new Error(`${at} names ${unknown.join(', ')}: an entry has table, select, insert, update, delete, rows and keeps_out only.`);
    const plainName = name => typeof name === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(name);
    if (entry.rows !== undefined && (entry.rows === null || typeof entry.rows !== 'object' || Object.keys(entry.rows).join() !== 'key' || !plainName(entry.rows.key))) throw new Error(`${at}.rows must be { key: column }: the column holding the digest of the key that opens a row.`);
    if (entry.keeps_out !== undefined && (entry.keeps_out === null || typeof entry.keeps_out !== 'object' || Array.isArray(entry.keeps_out) || Object.keys(entry.keeps_out).length === 0
      || Object.entries(entry.keeps_out).some(([column, keys]) => !plainName(column) || !Array.isArray(keys) || keys.length === 0 || keys.some(key => typeof key !== 'string' || key === '')))) throw new Error(`${at}.keeps_out must be { column: [key, ...] }: the keys of a jsonb column the login may never write a value into.`);
    if (typeof entry.table !== 'string' || !TABLE_NAME.test(entry.table)) throw new Error(`${at}.table must be a schema.table name.`);
    if (entry.table.startsWith('use_binding.')) throw new Error(`${at}.table may not be in the use_binding schema: its keys and claims are never the login's to read or change.`);
    for (const right of COLUMN_RIGHTS) {
      const named = entry[right];
      if (named !== undefined && (!Array.isArray(named) || named.length === 0 || named.some(column => typeof column !== 'string' || column === ''))) throw new Error(`${at}.${right} must be a list of column names.`);
    }
    if (entry.delete !== undefined && entry.delete !== true) throw new Error(`${at}.delete is true or left out.`);
    if (!COLUMN_RIGHTS.some(right => entry[right] !== undefined) && entry.delete !== true) throw new Error(`${at} names no right: give select, insert, update or delete.`);
  }
};

// The request's two shapes: { sql, params? } and { recipe }. Anything else is refused with its reason.
export function shapeOf(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // The names the request gives are text. An object or a number is refused in plain words, not read as absent; null is absent (a workflow binds an input not given as null).
  for (const name of ['credential_name', 'role_credential_name', 'value_credential_name', 'database']) {
    if (asked[name] !== undefined && asked[name] !== null && typeof asked[name] !== 'string') throw new Error(`${name} must be a name, as text.`);
  }
  const hasSql = Object.hasOwn(asked, 'sql');
  const hasRecipe = Object.hasOwn(asked, 'recipe');
  const hasStatements = Object.hasOwn(asked, 'statements');
  if (hasSql + hasRecipe + hasStatements > 1) throw new Error('Give one of: sql (with params), statements, or recipe.');
  if (hasStatements) {
    const { statements, then = 'rollback' } = asked;
    if (!Array.isArray(statements) || statements.length === 0 || statements.length > MAX_STATEMENTS) throw new Error(`statements must be a list of 1 to ${MAX_STATEMENTS} statements, each { sql, params }.`);
    const each = statements.map((given, index) => {
      if (given === null || typeof given !== 'object' || Array.isArray(given) || typeof given.sql !== 'string' || given.sql.trim() === '') throw new Error(`statements[${index}].sql must be a statement as text.`);
      if (given.params !== undefined && given.params !== null && !Array.isArray(given.params)) throw new Error(`statements[${index}].params must be a list of values.`);
      return { sql: given.sql, params: given.params ?? [] };
    });
    if (!['rollback', 'commit'].includes(then)) throw new Error('then must be rollback (nothing the statements did is kept) or commit.');
    if (asked.fence !== undefined) throw new Error('fence is answered for one statement: give sql with it.');
    return { kind: 'statements', statements: each, then, use: usedOf(asked.use) };
  }
  if (hasRecipe) {
    const { name, action, role, valid_until: validUntil, password_verifier: verifier, limits = {}, table, columns, fixed, tables: tablesGiven, writes: writesGiven } = asked.recipe ?? {};
    // A workflow input that is not given binds null: no tables named, the same as leaving them out.
    const tables = tablesGiven ?? undefined;
    const writes = writesGiven ?? undefined;
    if (!Object.hasOwn(RECIPES, name ?? '')) throw new Error(`recipe.name must be one of ${Object.keys(RECIPES).join(', ')}.`);
    if (!['create', 'drop', 'reset'].includes(action)) throw new Error('recipe.action must be create, drop or reset.');
    if (RECIPES[name][action] === undefined) throw new Error(`The ${name} recipe has no ${action}.`);
    if (role !== undefined && (typeof role !== 'string' || role === '')) throw new Error('recipe.role must be a role name.');
    if (validUntil !== undefined && Number.isNaN(Date.parse(validUntil))) throw new Error('recipe.valid_until must be a time, like 2026-12-01T00:00:00Z.');
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('recipe.limits must be an object of limit names and whole numbers.');
    const known = RECIPES[name].limits ?? {};
    for (const [limit, value] of Object.entries(limits)) {
      if (!Object.hasOwn(known, limit)) throw new Error(`recipe.limits.${limit} is not a limit of the ${name} recipe (${Object.keys(known).join(', ') || 'it has none'}).`);
      if (!(Number.isInteger(value) && value > 0)) throw new Error(`recipe.limits.${limit} must be a whole number above zero.`);
    }
    if (Object.keys(limits).length && action !== 'create') throw new Error('recipe.limits are set when a login is made: give them with create.');
    if (verifier !== undefined) {
      const match = typeof verifier === 'string' ? VERIFIER.exec(verifier) : null;
      if (!match) throw new Error('recipe.password_verifier must be a SCRAM-SHA-256 verifier (SCRAM-SHA-256$iterations:salt$StoredKey:ServerKey), made from the password by whoever keeps it.');
      if (Number(match[1]) < 4096) throw new Error('recipe.password_verifier must use at least 4096 iterations.');
      if (action !== 'create') throw new Error('recipe.password_verifier is given when a login is made: give it with create.');
      if (role === undefined) throw new Error('recipe.password_verifier needs recipe.role: the login name the password\'s keeper connects as.');
    }
    const addsRows = RECIPES[name].adds_rows === true;
    if (!addsRows && [table, columns, fixed].some(given => given !== undefined)) throw new Error(`recipe.table, recipe.columns and recipe.fixed are for a recipe that adds rows (${rowAddingRecipes.join(', ')}), not ${name}.`);
    if (addsRows) {
      if (typeof table !== 'string' || table === '') throw new Error(`The ${name} recipe needs recipe.table: the table whose rows the login may add.`);
      if (action === 'create') {
        if (!Array.isArray(columns) || columns.length === 0 || columns.some(column => typeof column !== 'string' || column === '')) throw new Error('recipe.columns must be the list of column names the login may name when it adds a row.');
        if (fixed !== undefined && (fixed === null || typeof fixed !== 'object' || Array.isArray(fixed))) throw new Error('recipe.fixed must be an object of column names and the value the server sets on every row the login adds.');
        for (const column of Object.keys(fixed ?? {})) if (columns.includes(column)) throw new Error(`recipe.fixed.${column} is also in recipe.columns: a column is the login's to name or the server's to set, not both.`);
      } else if (columns !== undefined || fixed !== undefined) throw new Error('recipe.columns and recipe.fixed are given when the rights are made: give them with create.');
    }
    if (tables !== undefined && RECIPES[name].per_table === undefined) throw new Error(`recipe.tables is for a recipe that grants per table (${perTableRecipes.join(', ')}), not ${name}.`);
    const named = tables === undefined ? [] : tablesOf(tables);
    if (RECIPES[name].per_write !== undefined && writes === undefined) throw new Error(`The ${name} recipe grants only what recipe.writes names: give writes.`);
    if (writes !== undefined) writesOf(name, writes);
    return { kind: 'recipe', name, action, role, validUntil, verifier, limits, table, columns, fixed: fixed ?? {}, tables: named.map(entry => entry.table), tableColumns: named, writes: writes ?? [] };
  }
  if (hasSql) {
    if (typeof asked.sql !== 'string' || asked.sql.trim() === '') throw new Error('sql must be a statement as text.');
    if (asked.params !== undefined && !Array.isArray(asked.params)) throw new Error('params must be a list of values.');
    if (asked.fence !== undefined && (typeof asked.fence !== 'string' || !TABLE_NAME.test(asked.fence) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(asked.fence))) throw new Error('fence must be a table name, as schema.table or table.');
    return { kind: 'sql', sql: asked.sql, params: asked.params ?? [], use: usedOf(asked.use), fence: asked.fence };
  }
  throw new Error('Give sql (with params), statements, or recipe.');
}

// A held connection's login: { role, password }.
const loginOf = connection => {
  const url = new URL(connection);
  return { role: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
};

// The held value a recipe fills in as %10$L: a recipe that takes one needs it to create, and one that takes none is never
// handed one, so a value is never sent where no statement asked for it.
const heldValueOf = (shape, heldValue) => {
  const takes = RECIPES[shape.name].takes_held_value === true;
  if (takes && shape.action === 'create' && !heldValue) throw new Error(`The ${shape.name} recipe takes a held value: give value_credential_name.`);
  if (!takes && heldValue) throw new Error(`The ${shape.name} recipe takes no held value: give no value_credential_name.`);
};

// The role a recipe makes or takes away, its password and when it stops working: a standing login is the held role
// connection's (descriptor 4); someone else's is the verifier they sent, with the role they named (and valid_until if given);
// a minted one is made up here and needs valid_until; a drop needs only the role.
const recipeLogin = (shape, roleConnection) => {
  if (RECIPES[shape.name].grants_only) {
    if (shape.role === undefined) throw new Error(`The ${shape.name} recipe gives rights to a login made elsewhere: give recipe.role.`);
    if (roleConnection || shape.verifier !== undefined || shape.validUntil !== undefined) throw new Error(`The ${shape.name} recipe makes no login: give only recipe.role (and limits are the login's own).`);
    if (Object.keys(shape.limits ?? {}).length) throw new Error(`The ${shape.name} recipe has no limits: a login's limits are set where it is made.`);
    return { role: shape.role, password: '', validUntil: 'infinity', minted: false };
  }
  if (shape.verifier !== undefined) {
    if (roleConnection) throw new Error('Give one of: role_credential_name (a login this computer holds) or recipe.password_verifier (one someone else holds).');
    return { role: shape.role, password: shape.verifier, validUntil: shape.validUntil ?? 'infinity', minted: false };
  }
  if (roleConnection) {
    const { role, password } = loginOf(roleConnection);
    if (shape.role !== undefined && shape.role !== role) throw new Error('recipe.role is not the role the held role connection names.');
    if (shape.action !== 'drop' && password.length < MIN_PASSWORD_LENGTH) throw new Error(`A standing login's password must be at least ${MIN_PASSWORD_LENGTH} characters, 32 random bytes as base64url or more: make a longer one on the computer that keeps it.`);
    if (shape.validUntil !== undefined) throw new Error('A standing login (role_credential_name) stops only when it is dropped; give no valid_until.');
    return { role, password, validUntil: 'infinity', minted: false };
  }
  if (shape.action === 'drop') {
    if (shape.role === undefined) throw new Error('A drop needs recipe.role or role_credential_name.');
    return { role: shape.role, password: '', validUntil: 'infinity', minted: false };
  }
  if (shape.action === 'reset') throw new Error('A reset needs role_credential_name: the new password is the one the held role connection names, which the server reads and never the request.');
  if (shape.validUntil === undefined) throw new Error('A minted login needs recipe.valid_until; a standing one needs role_credential_name.');
  return { role: shape.role ?? `${shape.name.replace(/[^a-z0-9]/g, '_')}_${randomBytes(6).toString('hex')}`, password: randomBytes(32).toString('base64url'), validUntil: shape.validUntil, minted: true };
};

// The statements a per-table or per-write role recipe runs, as one plan both roads fill the same way: runRecipe asks the server
// for each step's %13$s and then formats it, and keep-a-postgres-database-on-a-computer's prepare writes the same plan into a
// file psql runs (each step a `SELECT format(...) \gexec`). A step is [template, schema, table, named]: `named` is null (%13$s
// is empty) or { sql, params, refuse? }, one value the server works out from the entry's own words (the quoted column list, a
// resolved function, a row rule), and `refuse` is the refusal when the server answers null.
export const COLUMN_RIGHTS = ['select', 'insert', 'update'];

/** A per-table recipe's steps: per named table each per_table template, %13$s its columns, server-quoted in brackets, or
 * nothing when the entry is the whole table. */
export function perTablePlan(recipe, shape) {
  const templates = recipe.per_table?.[shape.action] ?? [];
  const steps = [];
  for (const { table, columns } of shape.tableColumns ?? []) {
    const [schema, name] = table.split('.');
    const named = columns === null ? null : { sql: "SELECT '(' || string_agg(format('%I', each), ', ') || ')' FROM unnest($1::text[]) AS columns(each)", params: [columns] };
    for (const template of templates) steps.push([template, schema, name, named]);
  }
  return steps;
}

/** A per-write recipe's steps: per table entry its schema's USAGE and one statement for each right it names, the columns quoted
 * by the server; per function entry the function the server resolves (one it cannot find is refused, never granted by a guessed
 * name). An entry's `rows` and `keeps_out` add the key binding (once), the key column (before any column right names it), the
 * table's row rules and the login's own rule, written by the server. A drop takes each table's and function's rights and the
 * login's rule back whatever the entry named. */
export function perWritePlan(recipe, shape) {
  const rights = recipe.per_write?.[shape.action];
  if (!rights) return [];
  const steps = [];
  for (const entry of shape.writes) {
    if (entry.function !== undefined) {
      steps.push([rights.function, null, null, { sql: 'SELECT pg_catalog.to_regprocedure($1)::text', params: [entry.function], refuse: `There is no function ${entry.function} in this database: the owner makes it first.` }]);
      continue;
    }
    const [schema, table] = entry.table.split('.');
    const ruled = entry.rows !== undefined || entry.keeps_out !== undefined;
    if (entry.rows !== undefined && !steps.some(([template]) => rights.row_binding.includes(template))) steps.push(...rights.row_binding.map(template => [template, null, null, null]));
    if (shape.action === 'drop') {
      if (ruled) steps.push(...rights.row_rules.map(template => [template, schema, table, null]));
      steps.push([rights.table, schema, table, null], [rights.usage, schema, table, null]);
      continue;
    }
    if (entry.rows !== undefined) steps.push([rights.row_key, schema, table, { sql: "SELECT format('%I', $1::text)", params: [entry.rows.key] }]);
    steps.push([rights.usage, schema, table, null]);
    for (const right of COLUMN_RIGHTS) {
      if (entry[right] !== undefined) steps.push([rights[right], schema, table, { sql: "SELECT string_agg(format('%I', each), ', ') FROM unnest($1::text[]) AS columns(each)", params: [entry[right]] }]);
    }
    if (entry.delete === true) steps.push([rights.delete, schema, table, null]);
    if (ruled) {
      const rule = { sql: `SELECT format('USING (%s) WITH CHECK (%s%s)', opened, opened, coalesce(kept, '')) FROM (SELECT CASE WHEN $1::text IS NULL THEN 'true' ELSE format('%I = ANY (use_binding.presented_keys())', $1::text) END AS opened,
        (SELECT string_agg(format(' AND coalesce(%I -> %L, ''null''::jsonb) = ''null''::jsonb', c.key, k), '') FROM jsonb_each($2::jsonb) c CROSS JOIN LATERAL jsonb_array_elements_text(c.value) k) AS kept) given`,
        params: [entry.rows?.key ?? null, JSON.stringify(entry.keeps_out ?? {})] };
      for (const template of rights.row_rules) steps.push([template, schema, table, template.includes('%13$s') ? rule : null]);
    }
  }
  return steps;
}

/** A SQL literal of one parameter, for a plan written into a file rather than sent with its parameters: text, a list of text, or
 * null (standard_conforming_strings, the server's default). */
const literal = value => (value === null || value === undefined ? 'NULL'
  : Array.isArray(value) ? `ARRAY[${value.map(literal).join(', ')}]::text[]` : `'${String(value).replace(/'/g, "''")}'`);
/** A step's `named` as one SQL expression with its parameters written in: the same query the server answers on run-sql's road. */
export const namedExpression = named => (named === null ? 'NULL' : `(${named.sql.replace(/\$(\d+)/g, (_, at) => literal(named.params[Number(at) - 1]))})`);

// A per-table or per-write recipe's steps (the plan above), each step's
// %13$s answered by the server: [template, schema, table, %13$s] each.
const filledSteps = async (client, plan) => {
  const steps = [];
  for (const [template, schema, table, named] of plan) {
    if (named === null) { steps.push([template, schema, table, null]); continue; }
    const { rows: [answer] } = await runOne(client, `SELECT (${named.sql}) AS named`, named.params);
    if (answer.named === null && named.refuse) throw new Error(named.refuse);
    steps.push([template, schema, table, answer.named]);
  }
  return steps;
};

// One recipe action, in one transaction unless the recipe says otherwise: each statement is filled by the server's format()
// and then run. %4$I is the database the connection names; %5$I the one the held role connection names.
const runRecipe = async (client, shape, connection, roleConnection, heldValue) => {
  const login = recipeLogin(shape, roleConnection);
  const database = new URL(connection).pathname.slice(1);
  const roleDatabase = roleConnection ? new URL(roleConnection).pathname.slice(1) : '';
  const recipe = RECIPES[shape.name], together = recipe.in_one_transaction !== false;
  if (!roleDatabase && recipe[shape.action].some(template => template.includes('%5$'))) throw new Error(`The ${shape.name} recipe names the held role connection's database: give role_credential_name.`);
  if (together) await runOne(client, 'BEGIN');
  try {
    // A row-adding recipe's %6$I is its table, %7$s its column names each quoted by the server and joined, %8$L its fixed values as
    // JSON text, %9$I the trigger's name; any other recipe is filled with nulls there. (%6$ is the limit's value in the limit statements below.)
    const { rows: [{ listed }] } = await runOne(client, "SELECT string_agg(format('%I', each), ', ') AS listed FROM unnest($1::text[]) AS columns(each)", [shape.columns ?? null]);
    const rule = recipe.adds_rows === true ? JSON.stringify(shape.fixed) : null;
    // A recipe that grants per table runs its per_table statements once for each named table, %11$I its schema and %12$I its table.
    // The whole public schema is read only when no tables are named: with recipe.tables the login reads exactly those tables.
    const publicGrants = shape.action === 'create' && shape.tables.length === 0 ? recipe.public_grants?.create ?? [] : [];
    const steps = [...[...recipe[shape.action], ...publicGrants].map(template => [template, null, null, null]),
      ...await filledSteps(client, [...perTablePlan(recipe, shape), ...perWritePlan(recipe, shape)])];
    // The functions the named tables' row policies call get EXECUTE for the login, and no other: read from pg_depend, so a
    // helper a policy names is granted and nothing a policy does not name. A policy function that is SECURITY INVOKER would run
    // as the login and read what the login may not, so its grant is refused; the owner makes it SECURITY DEFINER first.
    if (shape.tables.length) {
      const functions = await runOne(client, `SELECT DISTINCT CASE WHEN $3::text = 'drop' THEN format('REVOKE EXECUTE ON FUNCTION %s FROM %I', pr.oid::regprocedure, $2::text) ELSE format('GRANT EXECUTE ON FUNCTION %s TO %I', pr.oid::regprocedure, $2::text) END AS statement, pr.prosecdef AS definer, pr.oid::regprocedure::text AS fn FROM pg_policy pol JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_proc'::regclass JOIN pg_proc pr ON pr.oid = d.refobjid WHERE pol.polrelid = ANY (SELECT to_regclass(each) FROM unnest($1::text[]) AS named(each))`, [shape.tables, login.role, shape.action]);
      const invoked = functions.rows.filter(row => !row.definer).map(row => row.fn);
      if (invoked.length) throw new Error(`A row policy of ${shape.tables.join(', ')} calls ${invoked.join(', ')}, which is SECURITY INVOKER: it would run as the login. The owner makes it SECURITY DEFINER with a fixed search_path, then this grant.`);
      for (const { statement } of functions.rows) await runOne(client, statement);
    }
    for (const [template, schema, tableName, named] of steps) {
      const { rows: [{ statement }] } = await runOne(client, "SELECT format($1, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, left('rule_' || $2::text, 63), $10::text, $11::text, $12::text, $13::text) AS statement", [template, login.role, login.password, login.validUntil, database, roleDatabase, shape.table ?? null, listed, rule, heldValue || null, schema, tableName, named]);
      await runOne(client, statement);
    }
    for (const [limit, value] of Object.entries(shape.limits ?? {})) {
      const { rows: [{ statement }] } = await runOne(client, 'SELECT format($1, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text) AS statement', [recipe.limits[limit], login.role, login.password, login.validUntil, database, roleDatabase, String(value)]);
      await runOne(client, statement);
    }
    if (together) await runOne(client, 'COMMIT');
  } catch (error) {
    if (together) await runOne(client, 'ROLLBACK').catch(() => {});
    throw error;
  }
  const row = { role: login.role, recipe: shape.name, action: shape.action, valid_until: shape.action === 'create' ? login.validUntil : null };
  if (Object.keys(shape.limits ?? {}).length) row.limits = shape.limits;
  if (login.minted) {
    const url = new URL(connection);
    url.username = encodeURIComponent(login.role);
    url.password = encodeURIComponent(login.password);
    row.connection = url.toString();
  }
  return { columns: Object.keys(row), rows: [row], row_count: 1 };
};

const connectionOf = connection => {
  if (typeof connection !== 'string' || connection === '') throw new Error('No database connection was handed to this run. Hold the connection string under the name credential_name gives.');
  return connection;
};

// Runs the request as the connection's login. `connect` makes a connected client (a test hands its own); the client is
// always closed. A server error is the server's own text; the connection string is removed from any text first. `ticket` is
// the engine's use ticket (descriptor 5) and `heldValue` a recipe's held value (descriptor 6).
export async function runSql({ connection, roleConnection = '', ticket = '', heldValue = '', input, usedMs, connect = connectTo }) {
  connectionOf(connection);
  const shape = shapeOf(input);
  if (shape.kind === 'sql' && shape.fence !== undefined && !shape.use) throw new Error('fence is answered under a use: give use with it, so the claim the fence reports is the run\'s own.');
  if (shape.kind !== 'recipe' && shape.use && !ticket) throw new Error("A use is bound only by the engine's ticket: give database, so the computer opens it with the database's reader login and hands this run the ticket of its use.");
  if (shape.kind === 'recipe') heldValueOf(shape, heldValue);
  const client = await connect(connection, timeLimitOf(input.statement_timeout_ms, usedMs));
  try {
    if (shape.kind === 'sql') return ticket ? await runUnderTicket(client, shape, ticket) : await runOne(client, shape.sql, shape.params);
    if (shape.kind === 'statements') return await runInOneTransaction(client, shape, ticket);
    return await runRecipe(client, shape, connection, roleConnection, heldValue);
  } finally {
    await client.end().catch(() => {});
  }
}

// A computed read may need several bounded statements, but its use ticket is claimed once, in the transaction all of
// them read. The query callback holds no login or client. Without a declared use the transaction is read-only; with one,
// claim_use must write its claim, and the existing database reader login and row rules still own every statement's rights.
export const withSqlRead = (options, read) => onOneConnection(options, read, { writes: false });

// A step that reads and writes (a form's or a booking's step, a site's named write) runs every statement on one connection. Under
// a use it is one transaction that claims the use ticket once at its start (a ticket's nonce is claimed once, so a step of many
// transactions could hold its use for the first only), and the first statement the database refuses keeps nothing of the step;
// without one each statement stands alone (a step's writes are already one statement, store.ts oneStatementOf), so the owner's own
// step sends no transaction round trips. The login's grants (writer recipe may-write-named-columns-under-a-use) own what each
// statement may touch.
export const withSqlWrite = (options, work) => onOneConnection(options, work, { writes: true });

async function onOneConnection({ connection, ticket = '', use, statement_timeout_ms: timeout, usedMs, ceilingMs, connect = connectTo }, work, { writes }) {
  connectionOf(connection);
  const used = usedOf(use);
  if (used && !ticket) throw new Error("A use is bound only by the engine's ticket: give database, so the computer opens it with the database's reader login and hands this run the ticket of its use.");
  if (typeof work !== 'function') throw new Error(writes ? 'A step needs its statement function.' : 'A computed read needs its statement function.');
  const bound = timeLimitOf(timeout, usedMs, { ceilingMs }), client = await connect(connection, bound);
  let timer, closing;
  const close = () => closing ??= client.end().catch(() => {});
  const run = async () => {
    const query = (sql, params = []) => runOne(client, sql, params);
    if (writes && !used) return work(query);
    await runOne(client, used ? 'BEGIN' : 'BEGIN READ ONLY');
    try {
      if (used) await runOne(client, 'SELECT * FROM use_binding.claim_use($1)', [ticket]);
      const result = await work(query);
      await runOne(client, 'COMMIT');
      return result;
    } catch (error) {
      await runOne(client, 'ROLLBACK').catch(() => {});
      throw error;
    }
  };
  try {
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { void close(); reject(new Error(writes ? 'The step exceeded its transaction time bound.' : 'The computed read exceeded its transaction time bound.')); }, bound);
    });
    return await Promise.race([run(), expired]);
  } finally {
    clearTimeout(timer);
    await close();
  }
}

/**
 * How long this run's statements and open transactions may last in the database, in milliseconds: the time asked (or
 * time-limits.json `default_ms`), never past the row's own ceiling (invoke.max_run_ms), less `margin_ms` and the time this
 * process has already run (`usedMs`). A run with no time left is refused before it connects.
 */
export function timeLimitOf(asked, usedMs = Math.ceil(process.uptime() * 1000), { limits = TIME_LIMITS, ceilingMs = ROW?.invoke?.max_run_ms } = {}) {
  if (asked !== undefined && !(Number.isInteger(asked) && asked > 0)) throw new Error('statement_timeout_ms must be a whole number of milliseconds above zero.');
  if (!(Number.isInteger(ceilingMs) && ceilingMs > 0)) throw new Error('This tool\'s row declares no invoke.max_run_ms, so it cannot say how long a statement may run.');
  if (asked !== undefined && asked > ceilingMs - limits.margin_ms) throw new Error(`statement_timeout_ms may be at most ${ceilingMs - limits.margin_ms} (this tool's run ends at ${ceilingMs}).`);
  const left = Math.min(asked ?? limits.default_ms, ceilingMs) - limits.margin_ms - usedMs;
  if (left <= 0) throw new Error('This run has no time left to send a statement.');
  return left;
}

// The two settings the server ends a statement and an open transaction by, each lowered to the run's time and never raised
// past a shorter one the login or its database already holds (a recipe's per-login statement_timeout stays the login's).
const ENDS_BY = ['statement_timeout', 'idle_in_transaction_session_timeout'];

export async function connectTo(connection, timeLimit) {
  // A run the engine sandboxes reaches its database by address through the run's own proxy (through-the-run-proxy.mjs).
  // The server ends a statement or an open transaction past the run's time itself (timeLimitOf), so nothing outlives the run.
  const proxy = process.env.HTTPS_PROXY;
  // The driver is loaded only to connect, so a computer's render (prepare-a-database-unit.mjs) reads this file's recipe plan
  // where no driver is installed.
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    await runOne(client, "SELECT set_config(name, LEAST(COALESCE(NULLIF(setting::bigint, 0), $1::bigint), $1::bigint)::text, false) FROM pg_settings WHERE name = ANY($2::text[])", [timeLimit, ENDS_BY]);
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

// The text of a failure with each connection string and its secret parts taken out.
export function sayWithout(error, ...connections) {
  let said = String(error?.message ?? error);
  const parts = [];
  for (const connection of connections) {
    parts.push(connection);
    try { const url = new URL(connection); parts.push(decodeURIComponent(url.password)); } catch { /* not a URL: only the whole text is removed */ }
  }
  for (const part of parts) if (part) said = said.split(part).join('[held]');
  return said;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '', roleConnection = '', ticket = '', heldValue = '';
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    // A request that names no connection is refused before any descriptor is read: the engine mounts descriptor 3 only for a
    // named one, and an unmounted descriptor may never answer, so the run would wait out its deadline.
    if (!namesTarget(input)) throw new Error('no credential_name (or other target) in the input: give credential_name (the name of the held connection) or database (the name of one of the databases). No connection was opened.');
    connection = held(CONNECTION_DESCRIPTOR);
    roleConnection = held(ROLE_CONNECTION_DESCRIPTOR);
    // Descriptors 5 and 6 are read only when the input is one the row mounts them for: an unmounted number may be one the
    // runtime itself opened (Node's own event queue), and reading that would wait for ever.
    if (input?.use !== undefined && input.use !== null && typeof input.database === 'string') ticket = held(TICKET_DESCRIPTOR);
    if (typeof input?.value_credential_name === 'string' && input.value_credential_name !== '') heldValue = held(HELD_VALUE_DESCRIPTOR);
    console.log(JSON.stringify(await runSql({ connection, roleConnection, ticket, heldValue, input })));
  } catch (error) {
    console.error(sayWithout(error, connection, roleConnection, ticket, heldValue));
    process.exitCode = 1;
  }
}
