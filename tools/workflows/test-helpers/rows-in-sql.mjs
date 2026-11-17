// tools/workflows/test-helpers/rows-in-sql.mjs
//
// What every test of a workflows tool that keeps rows in the person's own Postgres shares (not a test itself): a real
// PostgreSQL server in a folder of its own (no sudo), the `sql` function a tool is handed (read-data/sql.mjs), a few
// seeding helpers, and the way a tool's row is run for real: its packed files laid under one folder that stands for `/`
// (the pinned pg libraries linked in, as the engine places them), its argv run with the connection string on descriptor 3.
//
//   const db = await startDatabase();   db.sql, db.connection, db.reset(), db.another(), db.stop()
//   keep(db.sql, 'table', 'id', value)  one row of a table made as (id text primary key, value jsonb), replaced when it is there
//   keepWorkflow(db.sql, slug, { recipe, steps })
//   readRow(db.sql, 'table', 'id')      the row's value, or null
//   runRowIn(row, request, { connection })  -> { code, last, stderr }   the row run as the engine runs it
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { applySqlFiles, identifier, sqlOver } from '../read-data/sql.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tools = join(here, '..', '..');
const own = realpathSync(tmpdir());

const freePort = () => new Promise((done, fail) => {
  const probe = createServer();
  probe.on('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

// A server on a free port. Another test process may take the port between the pick and the start, so a start that fails is tried
// again on a new port.
async function startServer(attempt = 1) {
  const port = await freePort();
  const admin = { host: '127.0.0.1', port, user: 'postgres', password: 'made-up-admin-pw' };
  const server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(own, 'workflows-sql-')), user: admin.user, password: admin.password, port, persistent: false, onLog: () => {}, onError: () => {} });
  try {
    await server.initialise();
    await server.start();
  } catch (error) {
    if (attempt >= 4) throw error;
    return startServer(attempt + 1);
  }
  return { server, admin, port };
}

export async function startDatabase() {
  const { server, admin, port } = await startServer();
  const connection = `postgres://${admin.user}:${admin.password}@127.0.0.1:${port}/postgres`;
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  const sql = sqlOver(client);
  const db = {
    sql, connection,
    // The database as a person's new one is: nothing in it, then the tables of sql/.
    async reset() {
      await client.query('drop schema public cascade');
      await client.query('create schema public');
      await applySqlFiles(sql);
    },
    // A connection of its own, for a test that makes several calls at once (one connection answers one query at a time).
    async another() { const own = new pg.Client({ connectionString: connection }); await own.connect(); return { sql: sqlOver(own), end: () => own.end() }; },
    async stop() { await client.end(); await server.stop(); },
  };
  await db.reset();
  return db;
}

const table = async (sql, name) => sql(`create table if not exists ${identifier(name)} (id text primary key, value jsonb not null)`);

export async function keep(sql, name, id, value) {
  await table(sql, name);
  await sql(`insert into ${identifier(name)} (id, value) values ($1, $2::jsonb) on conflict (id) do update set value = excluded.value`, [id, JSON.stringify(value)]);
}

export async function readRow(sql, name, id) {
  const [row] = await sql(`select value from ${identifier(name)} where id = $1`, [id]);
  return row?.value ?? null;
}

// A person's own workflow: its recipe row and the rows of its steps, as sql/003 and sql/004 keep them.
export async function keepWorkflow(sql, slug, { recipe, steps }) {
  await keep(sql, 'workflow_recipe', slug, recipe);
  for (const step of steps) await sql('insert into workflow_step (id, recipe, position, value) values ($1, $2, $3, $4::jsonb) on conflict (id) do update set value = excluded.value', [`${slug}--${step.step}`, slug, step.position, JSON.stringify(step)]);
}

// A row's packed files laid under a new folder that stands for `/`: each `package` + `paths` copied to its `at`, each
// pinned library of `packages` linked from this folder's own node_modules (the engine places the pinned tarball there).
function lay(row) {
  const there = mkdtempSync(join(own, 'workflows-row-'));
  for (const spec of row.invoke.files.package_files) {
    if (spec.package !== undefined) {
      for (const path of spec.paths ?? []) {
        const source = join(tools, spec.package, path);
        if (!existsSync(source)) throw new Error(`${row.id} packs ${spec.package}/${path}, which is not here`);
        const target = join(there, spec.at, path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true });
      }
    } else {
      for (const pinned of spec.packages) {
        if (pinned.startsWith('node_modules/')) {
          for (const path of spec.paths) {
            const target = join(there, spec.at, path);
            mkdirSync(dirname(target), { recursive: true });
            cpSync(join(tools, '..', pinned, path), target);
          }
        } else {
          mkdirSync(dirname(join(there, spec.at)), { recursive: true });
          symlinkSync(join(here, '..', 'node_modules', pinned), join(there, spec.at));
        }
      }
    }
  }
  return there;
}

// The row run as the engine runs it: its argv under the laid folder, `request` on standard input, the connection string on descriptor 3.
export async function runRowIn(row, request, { connection }) {
  const there = lay(row);
  const argv = row.invoke.argv.map(word => (typeof word === 'string' && word.startsWith('/opt/') ? join(there, word) : word));
  const stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
  const child = spawn(process.execPath, argv.slice(1), { cwd: there, stdio, env: { PATH: process.env.PATH, HOME: there } });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdio[3].end(connection);
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise(done => child.on('close', done));
  const line = out.trim().split('\n').at(-1);
  let last;
  try { last = JSON.parse(line); } catch { last = undefined; }
  return { code, last, stderr: err, out };
}

export const readJson = name => JSON.parse(readFileSync(join(tools, name), 'utf8'));

// The descriptor whose pg pins every row of this folder copies. Read by name from the tools folder, not by an import path:
// the pins are compared by the tests, and no run of a workflows tool needs that folder.
export const runSqlDescriptor = () => readJson(join('run-sql-in-my-database', 'tool-rows.json')).records[0].payload;
