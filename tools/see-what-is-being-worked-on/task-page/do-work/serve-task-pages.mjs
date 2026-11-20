// tools/see-what-is-being-worked-on/task-page/do-work/serve-task-pages.mjs
//
// The task pages' kept session (tool:serve-the-task-pages): one process the engine keeps open and reaches by calls (MCP
// tools/call, one JSON-RPC message a line on standard input), so each ask of an open page is answered by connections opened
// once, never by a new run. The page itself is the row's page folder, served by this computer's own door on its loopback
// address (invoke.pages); it calls this session through the door's /mcp with the person's own sign-in.
//
// Every call names `dbs`, the databases the session was started with ([{ database }], the run's start input): the engine
// hands element i's login on descriptor 3 + i (secret_name_from_database), for the account's owner only. The session opens
// each once and keeps it. `pages_database` is the one of them whose task_pages table says which pursuits have a page:
// (pursuit, label, database, tables, place); a row that still names `connection_name` is read as its database (the name
// without `-connection`). A pursuit is answered only from a database the session holds.
//
//   pursuits {dbs, pages_database}           -> [{ id, label }]                       the pursuits with a page, in their place
//   data     {dbs, pages_database, p: [ids]} -> { tasks, statuses, shows, changes, facts, fact_kinds }  their pages joined
//
// Reads are the task page's own read-only SELECT (read-data/read-task-page.mjs); nothing is written, copied or kept.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { throughProxy } from '../../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';
import { taskPageFrom, taskPageSql } from '../read-data/read-task-page.mjs';

const FIRST_DESCRIPTOR = 3;
const SUFFIX = '-connection';
const NAME = /^[a-z_][a-z0-9_]*$/;

const TOOLS = [
  { name: 'pursuits', description: 'The pursuits that have a task page: [{ id, label }], in their place.',
    inputSchema: { type: 'object', required: ['dbs', 'pages_database'], properties: { dbs: { type: 'array' }, pages_database: { type: 'string' } } } },
  { name: 'data', description: 'The task pages of the chosen pursuits, joined: { tasks, statuses, shows, changes, facts, fact_kinds }.',
    inputSchema: { type: 'object', required: ['dbs', 'pages_database', 'p'], properties: { dbs: { type: 'array' }, pages_database: { type: 'string' }, p: { type: 'array', items: { type: 'string' } } } } },
];

/** A database's login as the engine handed it on its descriptor; empty when none was handed. */
const heldOn = descriptor => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };

/** One client for a connection string, reached through the run's own proxy when the engine names one. */
async function connectTo(connection) {
  const { default: pg } = await import('pg');
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  return client;
}

/** A text with every held connection (and its password) taken out. */
function without(text, connections) {
  let said = String(text);
  for (const connection of connections) {
    if (!connection) continue;
    said = said.split(connection).join('[held]');
    try { const password = decodeURIComponent(new URL(connection).password); if (password) said = said.split(password).join('[held]'); } catch { /* not a URL */ }
  }
  return said;
}

/** The session's answers. `open(database, index)` gives a client with `query(text, values) -> { rows }` for dbs[index]; a
 *  test hands its own. The first call fixes the databases; a later call naming others is refused (the engine starts a
 *  separate session for another start input). */
export function taskPagesSession({ open }) {
  let named = null;
  const clients = new Map();
  const databasesOf = dbs => {
    if (!Array.isArray(dbs) || dbs.length === 0) throw new Error('dbs names no database.');
    const names = dbs.map(one => (typeof one?.database === 'string' && NAME.test(one.database) ? one.database : null));
    if (names.includes(null)) throw new Error('Each of dbs is { database } with a plain database name.');
    const key = JSON.stringify(names);
    if (named === null) named = key;
    else if (named !== key) throw new Error('This session holds other databases; a call names the dbs it was started with.');
    return names;
  };
  const client = async (names, database) => {
    const index = names.indexOf(database);
    if (index < 0) throw new Error(`${database} is not one of the databases this page was started with.`);
    // A database that failed to open is asked again by the next call, never kept failed.
    if (!clients.has(database)) clients.set(database, Promise.resolve(open(database, index)).catch(error => { clients.delete(database); throw error; }));
    return clients.get(database);
  };
  const pages = async (names, pagesDatabase) => {
    const { rows } = await (await client(names, pagesDatabase)).query('select to_jsonb(t) as row from task_pages t order by place');
    return rows.map(({ row }) => ({
      pursuit: String(row.pursuit), label: String(row.label ?? row.pursuit), tables: row.tables ?? {},
      database: typeof row.database === 'string' ? row.database : String(row.connection_name ?? '').replace(new RegExp(`${SUFFIX}$`), ''),
    }));
  };
  async function pursuits({ dbs, pages_database: pagesDatabase }) {
    const names = databasesOf(dbs);
    return (await pages(names, pagesDatabase)).filter(page => names.includes(page.database)).map(page => ({ id: page.pursuit, label: page.label }));
  }
  async function data({ dbs, pages_database: pagesDatabase, p }) {
    const names = databasesOf(dbs);
    if (!Array.isArray(p)) throw new Error('p is the list of pursuit ids to show.');
    const chosen = (await pages(names, pagesDatabase)).filter(page => p.includes(page.pursuit) && names.includes(page.database));
    const parts = await Promise.all(chosen.map(async page => taskPageFrom((await (await client(names, page.database)).query(taskPageSql(page.tables))).rows)));
    const first = (key, field) => { const kept = new Map(); for (const part of parts) for (const one of part[key] ?? []) if (!kept.has(one[field])) kept.set(one[field], one); return [...kept.values()].sort((a, b) => a.place - b.place); };
    const joined = key => parts.flatMap(part => part[key] ?? []);
    return { tasks: joined('tasks'), statuses: first('statuses', 'name'), shows: joined('shows'), changes: joined('changes').sort((a, b) => a.at.localeCompare(b.at)),
      facts: joined('facts'), fact_kinds: first('fact_kinds', 'name') };
  }
  return { pursuits, data };
}

/** One JSON-RPC message in, its reply out (null for a notification). */
export async function answer(session, message) {
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'serve-the-task-pages', version: '1' } });
  if (message.id === undefined) return null;
  if (message.method === 'tools/list') return reply({ tools: TOOLS });
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `No method ${message.method}.` } };
  const { name, arguments: args = {} } = message.params ?? {};
  if (!Object.hasOwn(session, name)) return reply({ isError: true, content: [{ type: 'text', text: `No call ${name}.` }] });
  try {
    const value = await session[name](args);
    return reply({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { items: value } : value });
  } catch (error) {
    return reply({ isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const held = [];
  const session = taskPagesSession({
    open: async (_database, index) => {
      const connection = heldOn(FIRST_DESCRIPTOR + index);
      if (!connection) throw new Error('No login was handed for that database.');
      held.push(connection);
      return connectTo(connection);
    },
  });
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    answer(session, message).then(reply => {
      if (reply) process.stdout.write(`${JSON.stringify(reply.result?.isError ? { ...reply, result: { ...reply.result, content: reply.result.content.map(part => ({ ...part, text: without(part.text, held) })) } } : reply)}\n`);
    });
  }
}
