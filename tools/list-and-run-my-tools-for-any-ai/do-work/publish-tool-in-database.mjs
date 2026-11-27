import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/list-and-run-my-tools-for-any-ai/do-work/publish-tool-in-database.mjs
//
// tool:publish-tool, one container process (what-this-tool-does-and-how-to-run-it.json): lists one saved tool in the database the request names (`database`).
// The request is one JSON object on stdin; the connection string is a held value on descriptor 3 (the row's invoke.key),
// never in the request, argv, a file or the environment. The publishing rules are publishTool's (publish-tool.mjs).
import { readFileSync } from 'node:fs';
import { publishTool } from './publish-tool.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

const CONNECTION_DESCRIPTOR = 3;

/** Run one action in the named database: the request on stdin, the connection on descriptor 3, one JSON answer on stdout. */
export async function runInDatabase(action) {
  const { default: pg } = await import('pg');
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const connection = readFileSync(CONNECTION_DESCRIPTOR, 'utf8').trim();
  const proxy = process.env.HTTPS_PROXY;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return { result: await action(request, client) };
  } finally {
    await client.end();
  }
}

export async function main() {
  return runInDatabase(publishTool);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
