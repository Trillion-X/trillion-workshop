// tools/keep-ai-provider-limits/do-work/keep-ai-provider-limits.mjs
//
// Purpose
//   Keeps the provider_limits rows of one AI subscription current from the response headers of one tiny call through the
//   local proxy. It runs as a due-time wake on the computer that runs the proxy. It sends nothing while a row of its provider
//   was read in the quiet window, and writes only the rate-limit headers the proxy passes back (harness/claude-limits.mjs maps them).
//   The store and the proxy come from the run's input (the person's wake row names them); nothing here names a product, a database or a path.
//
// Input (stdin JSON): { store: { credential_name }, provider, proxy_address, model, account, quiet_minutes }
// Output (stdout JSON): { sent, reason, rows }
//
// Non-negotiable invariants
//   1. The proxy key is read from the descriptor the run hands on fd 4 (the row's credential_mounts), never from argv or a file.
//   2. Writes go through tool:run-sql-in-my-database on the records door the run was handed; the store is named by the input.
//   3. A row is written only from a response's own headers. A failed call writes nothing.
//   4. At most one probe per quiet window: a probe is skipped when a row of this provider was read inside it.
//
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { rowsFromHeaders, upsertLimit } from '../../keep-and-wake-ai-sessions-on-this-computer/harness/claude-limits.mjs';

const KEY_DESCRIPTOR = 4;

const input = JSON.parse((await text(process.stdin)) || '{}');
const { store, provider, proxy_address: proxyAddress, model, account, quiet_minutes: quietMinutes } = input;
if (!store?.credential_name || !provider || !proxyAddress || !model || !account || !(quietMinutes > 0)) {
  throw Object.assign(new Error('The input names the store, provider, proxy_address, model, account and quiet_minutes.'), { status: 400 });
}

const door = openRecordsDoor();
const runSql = async (statement, params = []) => {
  const answer = await door.run('tool:run-sql-in-my-database', { credential_name: store.credential_name, sql: statement, params, statement_timeout_ms: 60000 });
  return answer.rows ?? answer.result?.rows ?? [];
};

const recent = await runSql(`select max(read_at) as last from provider_limits where provider = $1 and read_at > now() - ($2 || ' minutes')::interval`, [provider, String(quietMinutes)]);
if (recent[0]?.last) {
  process.stdout.write(`${JSON.stringify({ sent: false, reason: `a ${provider} row was read at ${recent[0].last}; quiet for ${quietMinutes} minutes`, rows: [] })}\n`);
  process.exit(0);
}

const key = readFileSync(`/dev/fd/${KEY_DESCRIPTOR}`, 'utf8').trim();
const response = await fetch(`${proxyAddress.replace(/\/$/, '')}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${key}`, 'x-api-key': key },
  body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  signal: AbortSignal.timeout(60000),
});
await response.text();
if (!response.ok) {
  process.stdout.write(`${JSON.stringify({ sent: true, reason: `the proxy answered ${response.status}; nothing written`, rows: [] })}\n`);
  process.exit(1);
}

const rows = rowsFromHeaders(response.headers, { account, readAt: new Date().toISOString() });
for (const row of rows) {
  const { sql: statement, params } = upsertLimit(row);
  await runSql(statement, params);
}
process.stdout.write(`${JSON.stringify({ sent: true, reason: 'one probe sent', rows })}\n`);
