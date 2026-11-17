// tools/workflows/read-data/with-sql.mjs
//
// The run every workflows row that keeps rows in the person's own Postgres makes (the two entry programs in do-work/ call it):
// it imports the module the row names, calls the export the row names with the run's stdin and prints { result } (or { error })
// as its last line.
//
//   runWithSql({ file, name, openDoor?, usageOk?, sqlFolders? })   `sqlFolders` are the tool's own folders of tables, applied after sql/   `usageOk: false` is an entry that was given arguments it does not take
//
// The function is called as fn(request, { sql, door }) (read-data/sql.mjs). `door` is there only when the entry hands an
// `openDoor`: the files door of the person's own files (the row's `files` right); it offers `files` and opens the door on its
// first call, so a function that destructures it and never reads a file opens nothing. The connection string is the person's
// held value, handed to this one process on a private pipe, descriptor 3 (the row's invoke.credential_mounts); it is never in
// argv, a file or the environment, and no answer or error holds it. Any server that speaks the Postgres wire protocol answers.
// Each statement goes through the extended query protocol as a named statement, which the server refuses when the text holds
// more than one command. The tables are made first from sql/ (applySqlFiles), once per run, each one `create ... if not exists`.
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applySqlFiles, sayWithout, sqlFiles, sqlOver, SQL_FOLDER } from './sql.mjs';

export const CONNECTION_DESCRIPTOR = 3;

export async function runWithSql({ file, name, openDoor = null, usageOk = true, sqlFolders = [] }) {
  let connection = '';
  let client;
  try {
    if (!usageOk || !file || !name) throw new Error('usage: <entry> <module file> <export name> < request.json');
    try { connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim(); } catch { connection = ''; }
    if (!connection) throw new Error('No connection to the database was handed to this run.');
    const fn = (await import(pathToFileURL(file).href))[name];
    if (typeof fn !== 'function') throw new Error(`${file} has no function ${name}.`);
    const request = JSON.parse((await text(process.stdin)) || '{}');
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    const sql = sqlOver(client);
    await applySqlFiles(sql, [SQL_FOLDER, ...sqlFolders].flatMap(folder => sqlFiles(folder)));
    let door;
    const context = { sql, door: openDoor === null ? undefined : { files: (...asked) => (door ??= openDoor()).files(...asked) } };
    console.log(JSON.stringify({ result: await fn(request, context) }));
  } catch (error) {
    console.log(JSON.stringify({ error: sayWithout(error, connection) }));
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}
