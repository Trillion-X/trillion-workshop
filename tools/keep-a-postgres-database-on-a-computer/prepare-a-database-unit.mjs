// tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs
//
// PostgreSQL's own part of a computer row: a database unit's `reach` (who may reach the server, and over what) made into the
// lines and files the server reads. start-a-computer knows no program; a unit that names this file as its `prepare` is handed
// to `prepare` before it renders, and gets back the unit as the computer runs it, the files it reads, and the ports it opens
// (moved here from start-a-computer's render-what-a-computer-runs.mjs, Nov 18 2026, K2 of the plan that no
// general tool knows a program).
//
// A unit without `reach` keeps PostgreSQL's own defaults: it is handed back as it came, with no access file.
//
// A unit's `grants` (a login's rights, Nov 25 2026) are made into the SQL file the database's owner runs: the plan of one
// run-sql-in-my-database role recipe (run-sql.mjs perWritePlan, the plan run-sql itself fills), for the writes a tool's own rights
// file names, each statement filled by the server's format() as run-sql fills it. The row names the login, the database, its
// owner, the recipe and the rights file; it holds no statement, no column and no row rule.
//
// A reader's `grants` (reads_from, Nov 25 2026) name the rights files of every tool that reads through that login, each the
// tool's own reads ({ reads: [{ table, columns }] }). The file renders their union, exactly: every table the login may read
// in a schema the files name has its read taken back, then each named table gets the union of the columns the files name for
// it (the per-table recipe's own grants, as run-sql fills them), all in one transaction, so no read stops between the two. A
// tool that stops reading a column takes it out of the grant, and a table no tool reads any more is read by none.
import { readFileSync } from 'node:fs';
import { namedExpression, perTablePlan, perWritePlan, shapeOf } from '../run-sql-in-my-database/do-work/run-sql.mjs';

const WORKSHOP = new URL('../../', import.meta.url);
const ROLE_RECIPES = 'tools/run-sql-in-my-database/read-data/role-recipes.json';
const POSTGRES_WORD = /^[A-Za-z0-9_.:/,@+-]+$/;

/** One `pg_hba.conf` line from a reach entry's `hba` row, in the server's own words: type, database, user, address (none
 * for a local socket) and method. Each word is one token with no space, so a row cannot add a line. */
const hbaLine = (row, where) => {
  const words = [row?.type, row?.database, row?.user, ...(row?.address === undefined ? [] : [row.address]), row?.method];
  if (!words.every(word => typeof word === 'string' && POSTGRES_WORD.test(word))) throw new Error(`${where} hba rows need type, database, user, method and, for a host line, address, each one word`);
  return words.join(' ');
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const RIGHTS_FILE = /^tools\/[a-z0-9-]+\/read-data\/[a-z0-9-]+\.json$/;
const literal = text => (text === null ? 'NULL' : `'${String(text).replace(/'/g, "''")}'`);

/** A unit's `grants` as the file the database's owner runs: a writer's { login, database, owner, recipe, writes_from,
 * table_names?, file, action? }, or a reader's { login, database, owner, recipe, reads_from, table_names?, file }. `writes_from` is a tool's rights file ({ writes: [...] }, the shape run-sql's per_write recipes take); a table it
 * names with a <placeholder> gets its name from `table_names`. `action` drop renders the recipe's drop: the way back. Each step
 * is one `SELECT format(...) \gexec` with format()'s arguments in runRecipe's order (%1$I the login, %4$I the database, %9$I its
 * rule's name, %11$I the schema, %12$I the table, %13$s the step's value the server works out). */
const grantsFile = (grants, unit, where) => (grants.reads_from === undefined ? writesFile(grants, unit, where) : readsFile(grants, unit, where));

/** The checks every grants entry shares, and the step each plan entry becomes in the file. */
const entryOf = (grants, unit, where) => {
  const { login, database, owner, file, action = 'create' } = grants;
  if (![login, database, owner].every(word => typeof word === 'string' && IDENTIFIER.test(word))) throw new Error(`${where} grants need login, database and owner, each a lower-case name`);
  if (typeof file !== 'string' || !file.startsWith('/') || !POSTGRES_WORD.test(file)) throw new Error(`${where} grants need file: the absolute path of the SQL file the owner runs`);
  if (action !== 'create' && action !== 'drop') throw new Error(`${where} grants action is create or drop`);
  const socket = (unit.environment ?? []).find(line => line.startsWith('PGHOST='))?.slice('PGHOST='.length);
  if (!socket?.startsWith('/')) throw new Error(`${where} grants are run over the unit's own socket: its environment needs PGHOST=/a/socket/folder`);
  const step = ([template, schema, table, named]) => [
    ...(named?.refuse ? [`DO $check$ BEGIN IF ${namedExpression(named)} IS NULL THEN RAISE EXCEPTION '%', ${literal(named.refuse)}; END IF; END $check$;\n`] : []),
    `SELECT pg_catalog.format(${literal(template)}, ${literal(login)}, NULL, NULL, ${literal(database)}, NULL, NULL, NULL, NULL, left(${literal(`rule_${login}`)}, 63), NULL, ${literal(schema)}, ${literal(table)}, ${namedExpression(named)}) \\gexec\n`,
  ];
  const then = [['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-d', database, '-f', file]];
  return { login, database, owner, file, action, step, then };
};

/** A rights file's table, its <placeholder> named by table_names. */
const tableNamed = (table, names, from, where) => {
  const named = String(table).replace(/<[a-z_]+>/g, placeholder => names[placeholder] ?? placeholder);
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(named)) throw new Error(`${where} grants: ${from} names ${table}, which is not schema.table${/</.test(named) ? ' (table_names gives no name for its placeholder)' : ''}`);
  return named;
};

/** A reader's grants: { login, database, owner, recipe (a per-table recipe), reads_from: [rights files], table_names?, file }. */
const readsFile = (grants, unit, where) => {
  const { login, database, owner, file, action, step, then } = entryOf(grants, unit, where);
  const { recipe: recipeName, reads_from: files, table_names: names = {} } = grants;
  if (grants.writes_from !== undefined) throw new Error(`${where} grants name reads_from or writes_from, not both`);
  if (action !== 'create') throw new Error(`${where} grants with reads_from are always the union of what the tools read: to take every read back, name no file that reads`);
  if (!Array.isArray(files) || files.length === 0 || files.some(from => typeof from !== 'string' || !RIGHTS_FILE.test(from))) throw new Error(`${where} grants reads_from is a list of tools' read-data JSON files`);
  const recipe = JSON.parse(readFileSync(new URL(ROLE_RECIPES, WORKSHOP), 'utf8')).recipes[recipeName];
  if (!recipe?.per_table || recipe.grants_only !== true) throw new Error(`${where} grants recipe must be a grants-only per-table recipe of ${ROLE_RECIPES}`);
  const union = new Map();
  for (const from of files) {
    const { reads } = JSON.parse(readFileSync(new URL(from, WORKSHOP), 'utf8'));
    if (!Array.isArray(reads) || reads.length === 0) throw new Error(`${where} grants: ${from} names no reads`);
    for (const entry of reads) {
      const table = tableNamed(entry?.table, names, from, where);
      if (!Array.isArray(entry.columns) || entry.columns.length === 0 || entry.columns.some(column => typeof column !== 'string' || !column)) throw new Error(`${where} grants: ${from} reads ${table} with no columns named`);
      union.set(table, new Set([...(union.get(table) ?? []), ...entry.columns]));
    }
  }
  const tables = [...union].sort(([a], [b]) => a.localeCompare(b)).map(([table, columns]) => ({ table, columns: [...columns].sort() }));
  // run-sql's own reading of the request it would be given, then its per-table steps.
  const shape = shapeOf({ recipe: { name: recipeName, action, role: login, tables } });
  const schemas = [...new Set(tables.map(({ table }) => table.split('.')[0]))];
  const takeBack = `SELECT pg_catalog.format('REVOKE SELECT ON TABLE %I.%I FROM %I', n.nspname, c.relname, ${literal(login)}) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`
    + ` WHERE n.nspname = ANY (ARRAY[${schemas.map(literal).join(', ')}]::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`
    + ` AND (pg_catalog.has_table_privilege(${literal(login)}, c.oid, 'SELECT') OR pg_catalog.has_any_column_privilege(${literal(login)}, c.oid, 'SELECT')) ORDER BY 1 \\gexec\n`;
  return {
    path: file,
    text: `-- Rendered from this computer's row: the reads of ${files.join(', ')} for the login ${login} in ${database} (${recipeName}), exactly.\n`
      + `BEGIN;\nSELECT pg_catalog.format('SET ROLE %I', ${literal(owner)}) \\gexec\n${takeBack}${perTablePlan(recipe, shape).flatMap(step).join('')}COMMIT;\n`,
    then,
  };
};

/** A writer's grants: { login, database, owner, recipe (a per-write recipe), writes_from, table_names?, file, action? }. */
const writesFile = (grants, unit, where) => {
  const { login, database, owner, file, action, step, then } = entryOf(grants, unit, where);
  const { recipe: recipeName, writes_from: from, table_names: names = {} } = grants;
  if (typeof from !== 'string' || !RIGHTS_FILE.test(from)) throw new Error(`${where} grants writes_from names a tool's read-data JSON file`);
  const recipe = JSON.parse(readFileSync(new URL(ROLE_RECIPES, WORKSHOP), 'utf8')).recipes[recipeName];
  if (!recipe?.per_write || recipe.grants_only !== true) throw new Error(`${where} grants recipe must be a grants-only per-write recipe of ${ROLE_RECIPES}`);
  const { writes: given } = JSON.parse(readFileSync(new URL(from, WORKSHOP), 'utf8'));
  if (!Array.isArray(given) || given.length === 0) throw new Error(`${where} grants: ${from} names no writes`);
  const writes = given.map(entry => {
    if (entry.table === undefined) return entry;
    return { ...entry, table: tableNamed(entry.table, names, from, where) };
  });
  // The request run-sql would be given, checked by run-sql's own reading of it; then runRecipe's order: the recipe's own
  // statements, then its per-write steps.
  const shape = shapeOf({ recipe: { name: recipeName, action, role: login, writes } });
  const plan = [...recipe[action].map(template => [template, null, null, null]), ...perWritePlan(recipe, shape)];
  return {
    path: file,
    text: `-- Rendered from this computer's row: ${recipeName} (${action}) for the login ${login} in ${database}, the writes ${from} names.\n`
      + `SELECT pg_catalog.format('SET ROLE %I', ${literal(owner)}) \\gexec\n${plan.flatMap(step).join('')}`,
    then,
  };
};

/** A database unit as the computer runs it: the address list it listens on (every `reach` entry's `listen`; none is no
 * network listener) and the access file at its `hba_file` (every entry's `hba` rows and nothing else, so who may connect is
 * only what the entries say), written as `settings_lines` and `files`; and the ports the entries open (`firewall_allow`). */
export function prepare(given) {
  const where = `unit ${given.unit}`;
  const { grants, ...rest } = given;
  if (grants !== undefined) {
    if (!Array.isArray(grants)) throw new Error(`${where} grants is a list of entries`);
    const answer = prepare(rest);
    return { ...answer, unit: { ...answer.unit, files: [...(answer.unit.files ?? []), ...grants.map((entry, at) => grantsFile(entry, rest, `${where} grants ${at}`))] } };
  }
  if (given.reach === undefined) return { unit: given };
  const { reach, hba_file, ...unit } = given;
  if (!Array.isArray(reach) || typeof hba_file !== 'string' || !hba_file.startsWith('/')) throw new Error(`${where} reach is a list of entries, and needs hba_file: the path of the access file the server reads`);
  if ((unit.settings_lines ?? []).some(line => /^\s*(listen_addresses|hba_file)\s*=/.test(line))) throw new Error(`${where} settings_lines must not set listen_addresses or hba_file: its reach renders them`);
  const listen = [...new Set(reach.map(entry => entry.listen).filter(address => address !== undefined))];
  if (!listen.every(address => typeof address === 'string' && POSTGRES_WORD.test(address))) throw new Error(`${where} reach listen must be one address`);
  const lines = reach.flatMap((entry, at) => (entry.hba ?? []).map(row => hbaLine(row, `${where} reach ${at}`)));
  return {
    unit: {
      ...unit,
      settings_lines: [...(unit.settings_lines ?? []), `listen_addresses = '${listen.join(',')}'`, `hba_file = '${hba_file}'`],
      // A changed access file is read by a reload (SIGHUP), so the server keeps its connections: written as a plain file it made
      // every apply that added an hba line restart PostgreSQL, and each restart dropped a site's connections (6 s of 502 on
      // Nov 25 2026 at 11:23 and 11:33 AM CST). try-: a server that is not running yet reads the file when it starts.
      files: [...(unit.files ?? []), { path: hba_file, text: lines.map(line => `${line}\n`).join(''), then: [['systemctl', 'try-reload-or-restart', unit.unit]] }],
    },
    firewall_allow: reach.flatMap(entry => entry.firewall_allow ?? []),
  };
}
