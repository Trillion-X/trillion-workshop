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
// A second shape runs a role recipe (read-data/role-recipes.json) as the connection's login: { recipe: { name, action, role?,
// valid_until?, limits? } }. `create` with a held role connection (role_credential_name, handed on descriptor 4) makes that standing
// login with the password the person holds; `create` with a password_verifier makes a login for someone else whose password
// only they hold (they send the SCRAM verifier made from it, never the password: do-work/make-a-login-verifier.mjs); `create`
// with valid_until and no held one mints a login that stops working then, and answers it once; `drop` takes a role away. Every value goes into the recipe's SQL through the server's own format().
// A recipe that adds rows (`adds_rows`) also takes { table, columns, fixed }: the one table, the columns the login may name and the
// values the server sets on every row it adds.
// A recipe runs in one transaction unless it says `in_one_transaction: false`: Postgres runs CREATE DATABASE and DROP
// DATABASE only outside a transaction block, so such a recipe's statements run one by one on the same connection.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { throughProxy } from './through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;
const ROLE_CONNECTION_DESCRIPTOR = 4;
// 32 random bytes written as base64url are 43 characters; a standing login's password shorter than that is refused.
const MIN_PASSWORD_LENGTH = 43;
// A SCRAM-SHA-256 verifier as Postgres keeps one (RFC 5803): iterations, salt, StoredKey and ServerKey. The server takes it as the
// role's password unchanged, so the password itself never reaches this computer. Fewer than 4096 iterations is refused.
const VERIFIER = /^SCRAM-SHA-256\$(\d+):[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const RECIPES = JSON.parse(readFileSync(new URL('../read-data/role-recipes.json', import.meta.url), 'utf8')).recipes;

const rowAddingRecipes = Object.keys(RECIPES).filter(name => RECIPES[name].adds_rows === true);

const held = descriptor => {
  try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; }
};

// One statement through the extended protocol; the answer is the columns, the rows and the rows' count.
let sent = 0;
const runOne = async (client, text, values = []) => {
  const result = await client.query({ name: `statement_${sent += 1}`, text, values });
  return { columns: result.fields.map(field => field.name), rows: result.rows, row_count: result.rowCount ?? result.rows.length };
};

// The request's two shapes: { sql, params? } and { recipe }. Anything else is refused with its reason.
export function shapeOf(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const hasSql = Object.hasOwn(asked, 'sql');
  const hasRecipe = Object.hasOwn(asked, 'recipe');
  if (hasSql + hasRecipe > 1) throw new Error('Give one of: sql (with params), or recipe.');
  if (hasRecipe) {
    const { name, action, role, valid_until: validUntil, password_verifier: verifier, limits = {}, table, columns, fixed } = asked.recipe ?? {};
    if (!Object.hasOwn(RECIPES, name ?? '')) throw new Error(`recipe.name must be one of ${Object.keys(RECIPES).join(', ')}.`);
    if (!['create', 'drop'].includes(action)) throw new Error('recipe.action must be create or drop.');
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
    return { kind: 'recipe', name, action, role, validUntil, verifier, limits, table, columns, fixed: fixed ?? {} };
  }
  if (hasSql) {
    if (typeof asked.sql !== 'string' || asked.sql.trim() === '') throw new Error('sql must be a statement as text.');
    if (asked.params !== undefined && !Array.isArray(asked.params)) throw new Error('params must be a list of values.');
    return { kind: 'sql', sql: asked.sql, params: asked.params ?? [] };
  }
  throw new Error('Give sql (with params), or recipe.');
}

// A held connection's login: { role, password }.
const loginOf = connection => {
  const url = new URL(connection);
  return { role: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
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
    if (shape.action === 'create' && password.length < MIN_PASSWORD_LENGTH) throw new Error(`A standing login's password must be at least ${MIN_PASSWORD_LENGTH} characters, 32 random bytes as base64url or more: make a longer one on the computer that keeps it.`);
    if (shape.validUntil !== undefined) throw new Error('A standing login (role_credential_name) stops only when it is dropped; give no valid_until.');
    return { role, password, validUntil: 'infinity', minted: false };
  }
  if (shape.action === 'drop') {
    if (shape.role === undefined) throw new Error('A drop needs recipe.role or role_credential_name.');
    return { role: shape.role, password: '', validUntil: 'infinity', minted: false };
  }
  if (shape.validUntil === undefined) throw new Error('A minted login needs recipe.valid_until; a standing one needs role_credential_name.');
  return { role: shape.role ?? `${shape.name.replace(/[^a-z0-9]/g, '_')}_${randomBytes(6).toString('hex')}`, password: randomBytes(32).toString('base64url'), validUntil: shape.validUntil, minted: true };
};

// One recipe action, in one transaction unless the recipe says otherwise: each statement is filled by the server's format()
// and then run. %4$I is the database the connection names; %5$I the one the held role connection names.
const runRecipe = async (client, shape, connection, roleConnection) => {
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
    for (const template of recipe[shape.action]) {
      const { rows: [{ statement }] } = await runOne(client, "SELECT format($1, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, left('rule_' || $2::text, 63)) AS statement", [template, login.role, login.password, login.validUntil, database, roleDatabase, shape.table ?? null, listed, rule]);
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

// Runs the request as the connection's login. `connect` makes a connected client (a test hands its own); the client is
// always closed. A server error is the server's own text; the connection string is removed from any text first.
export async function runSql({ connection, roleConnection = '', input, connect = connectTo }) {
  if (typeof connection !== 'string' || connection === '') throw new Error('No database connection was handed to this run. Hold the connection string under the name credential_name gives.');
  const shape = shapeOf(input);
  const timeout = input.statement_timeout_ms;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) throw new Error('statement_timeout_ms must be a whole number of milliseconds above zero.');
  const client = await connect(connection, timeout);
  try {
    if (shape.kind === 'sql') return await runOne(client, shape.sql, shape.params);
    return await runRecipe(client, shape, connection, roleConnection);
  } finally {
    await client.end().catch(() => {});
  }
}

async function connectTo(connection, statementTimeout) {
  // A run the engine sandboxes reaches its database by address through the run's own proxy (through-the-run-proxy.mjs).
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}), ...(statementTimeout ? { statement_timeout: statementTimeout } : {}) });
  await client.connect();
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connection = held(CONNECTION_DESCRIPTOR), roleConnection = held(ROLE_CONNECTION_DESCRIPTOR);
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await runSql({ connection, roleConnection, input })));
  } catch (error) {
    console.error(sayWithout(error, connection, roleConnection));
    process.exitCode = 1;
  }
}
