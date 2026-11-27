import { realpathSync } from 'node:fs';
// tools/send-a-report-or-a-note-to-the-people-who-make/do-work/tell-the-makers.mjs
//
// The container tool `tool:tell-the-makers-of-a-product` (what-this-tool-does-and-how-to-run-it.json): one feedback note written as one row of the makers'
// calendar_tasks. The login is the caller's own: input.credential_name names the held connection the caller's rows give (mounted on
// descriptor 3). That login may INSERT id, title and description only. The server sets the rest (labels, status, pursuit and
// sent_by), so this file never names them. Nothing here names a product, host or account.
//
// The id is content-addressed: 'record:calendar-task:feedback-' + BLAKE3 of the kind, the things, the note and the where, so the
// same feedback sent twice is refused as already taken rather than written twice. The title is the note's first line, cut to 80
// characters. The description is the whole note with its kind, where and screen. Nothing here reads a store or names a host:
// the connection string is held by the engine and reached through the run's proxy (the run-sql tool's own file, mounted beside it).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const CONNECTION_DESCRIPTOR = 3;
const KINDS = ['a bug report', 'friction', 'feedback', 'an idea'];
const NOTE_MAX = 8000;
const TITLE_MAX = 80;
const WHERE_MAX = 200;
const ID_PREFIX = 'record:calendar-task:feedback-';
const INSERT = 'INSERT INTO calendar_tasks (id, title, description) VALUES ($1, $2, $3)';

const held = descriptor => {
  try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; }
};

// The request as the caller sent it, checked: kind is one of four, note is text, the rest is optional text.
export function shapeOf(input) {
  const asked = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const { kind, note, things = [], where = '', screen = '', browser = '', picture = '' } = asked;
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}.`);
  if (typeof note !== 'string' || note.trim() === '') throw new Error('note must be your words, as text.');
  if (note.length > NOTE_MAX) throw new Error(`note must be at most ${NOTE_MAX} characters.`);
  if (!Array.isArray(things)) throw new Error('things must be a list.');
  if (typeof asked.credential_name !== 'string' || asked.credential_name === '') throw new Error('credential_name must name the held connection of your own makers login.');
  if (typeof where !== 'string' || where.length > WHERE_MAX) throw new Error(`where must be text of at most ${WHERE_MAX} characters.`);
  return { kind, note: note.trim(), things, where, screen, browser, picture, credential: asked.credential_name };
}

// The row: the id from the content, the title from the note's first line, the description from the whole note.
export function rowOf(request) {
  const { kind, note, things, where, screen } = request;
  const id = ID_PREFIX + bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([kind, things, note, where]))));
  const firstLine = note.split('\n')[0].trim();
  const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
  const description = [note, '', `Kind: ${kind}`, `Where: ${where || 'not said'}`, `Screen: ${screen || 'not said'}`].join('\n');
  return { id, title, description };
}

async function connectTo(connection) {
  // A run the engine sandboxes reaches its database by address through the run's own proxy (the run-sql tool's file, mounted beside this one).
  const { default: pg } = await import('pg');
  const proxy = process.env.HTTPS_PROXY;
  const stream = proxy ? (await import('../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs')).throughProxy(proxy) : undefined;
  const client = new pg.Client({ connectionString: connection, ...(stream ? { stream } : {}) });
  await client.connect();
  return client;
}

// One insert. Answers { id, row_count }; a duplicate id is refused with the words "already taken".
export async function tellTheMakers({ connection, input }) {
  const request = shapeOf(input);
  const row = rowOf(request);
  const client = await connectTo(connection);
  try {
    const result = await client.query({ name: 'tell_the_makers_insert', text: INSERT, values: [row.id, row.title, row.description] });
    return { id: row.id, row_count: result.rowCount ?? 0 };
  } catch (error) {
    if (error?.code === '23505') throw new Error('That feedback is already taken: the same note was sent before.');
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const connection = held(CONNECTION_DESCRIPTOR);
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(await tellTheMakers({ connection, input })));
  } catch (error) {
    console.error(String(error?.message ?? error).split(connection).join('[held]'));
    process.exitCode = 1;
  }
}
