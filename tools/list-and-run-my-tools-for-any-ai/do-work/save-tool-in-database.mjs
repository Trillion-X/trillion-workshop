import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/list-and-run-my-tools-for-any-ai/do-work/save-tool-in-database.mjs
//
// tool:save-tool, one container process (tool-rows.json): saves one tool as a row of the `saved_tools` table in the database the
// request names (`database`). The request is one JSON object on stdin ({ descriptor, files } or { descriptor, bytes_base64 }); the
// connection string is a held value the engine hands this process on descriptor 3 (the row's invoke.credential_mounts), so it is never
// in the request, argv, a file or the environment. The saving rules are saveTool's (save-tool.mjs).
import { readFileSync } from 'node:fs';
import { saveTool } from './save-tool.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;

/** The process entry: one JSON request on stdin, the connection on descriptor 3, one JSON answer on stdout. */
export async function main() {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return { result: await saveTool(request, client) };
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
