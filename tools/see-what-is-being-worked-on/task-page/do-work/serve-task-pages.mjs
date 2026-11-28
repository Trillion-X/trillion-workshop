import { realpathSync } from 'node:fs';
// tools/see-what-is-being-worked-on/task-page/do-work/serve-task-pages.mjs
//
// The task pages' kept session (tool:serve-the-task-pages): one process the engine keeps open and reaches by calls (MCP
// tools/call, one JSON-RPC message a line on standard input), so each ask of an open page is answered by connections opened
// once, never by a new run. The page itself is the row's page folder, served by this computer's own door on its loopback
// address (invoke.pages); it calls this session through the door's /mcp with the person's own sign-in.
//
// Every call names `dbs`, the databases the session was started with ([{ database }], the run's start input): the engine
// hands element i's login on descriptor 3 + i (secret_name_from_input with the row's held_suffix), for the account's owner only. The session opens
// each once and keeps it. `pages_database` is the one of them whose task_pages table says which pursuits have a page:
// (pursuit, label, database, tables, place); a row that still names `connection_name` is read as its database (the name
// without `-connection`). `pursuits` names every row with its database and tables; `data` is given the chosen rows (so a
// database that keeps no task_pages of its own is read all the same) and answers each from a database the session holds. One run never holds the keys of two places, so the page starts one session per database (dbs of one) and
// asks each pursuit's own database's session for its data.
//
//   pursuits {dbs, pages_database}           -> [{ id, label, database, tables }]       the pursuits with a page, in their place
//   data     {dbs, pursuits: [{ id, database, tables }]} -> { tasks, statuses, shows, changes, facts, fact_kinds }  their pages joined
//   part     {key, at}                        -> { part, at, total, key }                 the next piece of a long answer
//
// One reply line is held to one door message (the engine drops a longer line), so an answer whose JSON is longer than
// PART_BYTES is kept here as its text and answered in pieces: the first reply is { part, at: 0, total, key }, and the
// caller asks `part` with the key and the next `at` until it holds `total` characters, then parses the joined text. A
// kept answer is let go when its last piece is read, or KEPT_MS after it was made.
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
// The most bytes of answer one reply carries (well under the door's 1 MiB message once escaped inside the reply), and how
// long an answer read in pieces is kept for its caller.
const PART_BYTES = 400_000;
const KEPT_MS = 60_000;

const TOOLS = [
  { name: 'pursuits', description: 'The pursuits that have a task page: [{ id, label, database }], in their place.',
    inputSchema: { type: 'object', required: ['dbs', 'pages_database'], properties: { dbs: { type: 'array' }, pages_database: { type: 'string' } } } },
  { name: 'data', description: 'The task pages of the chosen pursuits (each as `pursuits` answered it: id, database, tables), joined: { tasks, statuses, shows, changes, facts, fact_kinds }.',
    inputSchema: { type: 'object', required: ['dbs', 'pursuits'], properties: { dbs: { type: 'array' }, pursuits: { type: 'array', items: { type: 'object' } } } } },
  { name: 'part', description: 'The next piece of a long answer: { part, at, total, key }, from the key and `at` its earlier piece named.',
    inputSchema: { type: 'object', required: ['key', 'at'], properties: { key: { type: 'string' }, at: { type: 'integer' } } } },
];

/** A database's login as the engine handed it on its descriptor; empty when none was handed. */
const heldOn = descriptor => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };

/** `read(index)` asked once for each index and kept: a descriptor read again starts at its end and finds nothing, so a
 *  connection opened again after a reset uses the login read the first time. */
export function readOnce(read) {
  const kept = new Map();
  return index => { if (!kept.has(index)) kept.set(index, read(index)); return kept.get(index); };
}

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
    // A connection the server or the network ends while it waits (an idle reset) is let go, so the next ask opens it again
    // and the session never ends over it.
    if (!clients.has(database)) {
      const opened = Promise.resolve(open(database, index)).then(
        made => { made.on?.('error', () => { if (clients.get(database) === opened) clients.delete(database); }); return made; },
        error => { clients.delete(database); throw error; });
      clients.set(database, opened);
    }
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
    return (await pages(names, pagesDatabase)).map(page => ({ id: page.pursuit, label: page.label, database: page.database, tables: page.tables }));
  }
  async function data({ dbs, pursuits: chosen }) {
    const names = databasesOf(dbs);
    if (!Array.isArray(chosen)) throw new Error('pursuits is the list of { id, database, tables } to show.');
    for (const page of chosen) if (!names.includes(page.database)) throw new Error(`${page.database} is not one of the databases this page was started with.`);
    const parts = await Promise.all(chosen.map(async page => taskPageFrom((await (await client(names, page.database)).query(taskPageSql(page.tables ?? {}))).rows)));
    const first = (key, field) => { const kept = new Map(); for (const part of parts) for (const one of part[key] ?? []) if (!kept.has(one[field])) kept.set(one[field], one); return [...kept.values()].sort((a, b) => a.place - b.place); };
    const joined = key => parts.flatMap(part => part[key] ?? []);
    return { tasks: joined('tasks'), statuses: first('statuses', 'name'), shows: joined('shows'), changes: joined('changes').sort((a, b) => a.at.localeCompare(b.at)),
      facts: joined('facts'), fact_kinds: first('fact_kinds', 'name') };
  }
  return { pursuits, data };
}

/** The answers too long for one reply, kept by key while their caller reads them in pieces. */
const kept = new Map();
let made = 0;

/** The piece of `text` from character `at` whose escaped JSON is at most PART_BYTES. */
function pieceOf(key, text, at) {
  let length = Math.min(text.length - at, PART_BYTES);
  for (let size = Buffer.byteLength(JSON.stringify(text.slice(at, at + length))); length > 1 && size > PART_BYTES;
    size = Buffer.byteLength(JSON.stringify(text.slice(at, at + length)))) length = Math.max(1, Math.floor(length * PART_BYTES / size * 0.98));
  const part = text.slice(at, at + length);
  if (at + length >= text.length) { clearTimeout(kept.get(key)?.timer); kept.delete(key); }
  return { part, at, total: text.length, key };
}

/** A call's value as its reply: whole when its JSON fits one reply, else the first piece of it. */
function replyOf(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= PART_BYTES) return { content: [{ type: 'text', text }], structuredContent: Array.isArray(value) ? { items: value } : value };
  const key = `answer-${process.pid}-${(made += 1)}`;
  kept.set(key, { text, timer: setTimeout(() => kept.delete(key), KEPT_MS).unref?.() });
  const piece = pieceOf(key, text, 0);
  return { content: [{ type: 'text', text: `Piece 1 of an answer of ${text.length} characters; ask part with key ${key}.` }], structuredContent: piece };
}

/** One JSON-RPC message in, its reply out (null for a notification). */
export async function answer(session, message) {
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'serve-the-task-pages', version: '1' } });
  if (message.id === undefined) return null;
  if (message.method === 'tools/list') return reply({ tools: TOOLS });
  if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `No method ${message.method}.` } };
  const { name, arguments: args = {} } = message.params ?? {};
  if (name === 'part') {
    const held = kept.get(String(args.key));
    const at = Number(args.at);
    if (!held || !Number.isInteger(at) || at < 0 || at >= held.text.length) return reply({ isError: true, content: [{ type: 'text', text: 'That answer is no longer kept; ask for it again.' }] });
    const piece = pieceOf(String(args.key), held.text, at);
    return reply({ content: [{ type: 'text', text: `Piece at ${at} of ${held.text.length} characters.` }], structuredContent: piece });
  }
  if (!Object.hasOwn(session, name)) return reply({ isError: true, content: [{ type: 'text', text: `No call ${name}.` }] });
  try {
    return reply(replyOf(await session[name](args)));
  } catch (error) {
    return reply({ isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] });
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const held = [];
  const loginOf = readOnce(index => heldOn(FIRST_DESCRIPTOR + index));
  const session = taskPagesSession({
    open: async (_database, index) => {
      const connection = loginOf(index);
      if (!connection) throw new Error('No login was handed for that database.');
      if (!held.includes(connection)) held.push(connection);
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
