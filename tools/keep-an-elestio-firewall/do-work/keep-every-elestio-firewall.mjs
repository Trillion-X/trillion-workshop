#!/usr/bin/env node
// tools/keep-an-elestio-firewall/do-work/keep-every-elestio-firewall.mjs
//
// PURPOSE: tool:keep-every-elestio-firewall, run in the tool container on a timer. Reads the request on stdin
// ({ credential_name, apply?, only? }), reads every computer row of the person's database whose runs.firewall names the
// provider elestio (the connection on descriptor 3), and makes each Elestio firewall equal its row's rules with
// keep-an-elestio-firewall.mjs (the held elestio-api-key on descriptor 4): one sign-in per account a run, since Elestio
// refuses bursts of sign-ins. A port a dashboard tool opened (Tail Logs 18445 and the like) is closed again on the next run,
// so the rows, not whoever last used the dashboard, say what is open. One computer that fails does not stop the others.
// Answers { ok, read_at, kept: [{ computer, ok, action, opened, closed, reason?, error? }] }; never the token or a session.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keepAnElestioFirewall, makeElestio, signIn } from './keep-an-elestio-firewall.mjs';

// The rows read: name and firewall of each computer whose runs.firewall is kept at Elestio, with the time of the read.
export const ROWS = `select name, runs::jsonb->'firewall' as firewall, to_json(now())#>>'{}' as read_at from computer
  where runs::jsonb->'firewall'->>'provider' = 'elestio' and (coalesce($1::text, '') = '' or name = $1::text) order by name`;

const fieldsOf = answer => ({
  ok: answer.ok, action: answer.action, opened: answer.opened, closed: answer.closed,
  ...(answer.reason ? { reason: answer.reason } : {}),
});

/** Keep every row's firewall. `sql(statement, params)` answers rows; the rest is passed to keepAnElestioFirewall. */
export async function keepEveryElestioFirewall(request, { sql, read, post = makeElestio(), wait, now } = {}) {
  if (typeof request?.credential_name !== 'string' || !request.credential_name) throw new Error('credential_name must name the held connection of the database that keeps the computer rows');
  const rows = await sql(ROWS, [request.only ?? null]);
  const sessions = new Map();
  const kept = [];
  for (const row of rows) {
    const firewall = row.firewall ?? {};
    try {
      const email = firewall.account_email;
      if (!sessions.has(email)) sessions.set(email, await signIn(email, { read, post }));
      const answer = await keepAnElestioFirewall({ email, project_id: firewall.project_id, vm_id: firewall.vm_id, rules: firewall.rules, apply: request.apply, wait_seconds: request.wait_seconds, poll_seconds: request.poll_seconds },
        { read, post, wait, now, jwt: sessions.get(email) });
      kept.push({ computer: row.name, vm_id: String(firewall.vm_id), ...fieldsOf(answer) });
    } catch (error) {
      kept.push({ computer: row.name, ok: false, action: null, opened: [], closed: [], error: String(error.message).slice(0, 300) });
    }
  }
  return { ok: kept.length > 0 && kept.every(item => item.ok), read_at: rows[0]?.read_at ?? null, kept };
}

// The database reached by its connection on descriptor 3, through the run's proxy when there is one (the SQL tool's own way).
async function sqlOverDescriptor() {
  const connection = readFileSync(3, 'utf8').trim();
  if (!connection) throw new Error('no database connection arrived on descriptor 3');
  const { default: pg } = await import('pg');
  const proxy = process.env.HTTPS_PROXY;
  const stream = proxy ? (await import('../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs')).throughProxy(proxy) : undefined;
  const client = new pg.Client({ connectionString: connection, ...(stream ? { stream } : {}) });
  await client.connect();
  return { sql: async (statement, params) => (await client.query(statement, params)).rows, end: () => client.end() };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  (async () => {
    const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const db = await sqlOverDescriptor();
    try { return await keepEveryElestioFirewall(request, { sql: db.sql }); } finally { await db.end().catch(() => {}); }
  })()
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${String(error.message).replace(/postgres(ql)?:\/\/\S+/g, '<connection>')}\n`); process.exit(1); });
}
