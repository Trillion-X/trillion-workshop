// tools/email-sending-domains/do-work/list-email-sending-domains.mjs
//
// The container tool `tool:list-email-sending-domains` (tool-rows.json): which domains the person's email-sending
// account (Resend) may send from, and how many. It only reads; it sends no email.
//
// The account key is never in the request, argv, a file or the environment: Trillion hands the person's own held
// key to this one process on a private pipe, descriptor 3 (the row's invoke.credential_mounts { fd: 3 }), and the
// pipe ends after the key. This command reads it, asks the provider once, and answers domain names, their states and
// the count only: never the key, a header or the provider's raw reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADDRESS = 'https://api.resend.com/domains';
const KEY_DESCRIPTOR = 3;

// The domains the key's account holds: { domains: [{ name, status }], count }.
export async function listDomains({ key, fetchImpl = fetch }) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('No email-sending key was handed to this run. Connect the email-sending account first.');
  const response = await fetchImpl(ADDRESS, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error(`The email-sending account refused the held key (${response.status}). Connect the account again with a current key.`);
  if (!response.ok) throw new Error(`The email-sending account answered ${response.status}. Try again later.`);
  const body = await response.json();
  const domains = (Array.isArray(body?.data) ? body.data : []).map(domain => ({ name: String(domain?.name ?? ''), status: String(domain?.status ?? 'unknown') }));
  return { domains, count: domains.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let key = '';
  try { key = readFileSync(KEY_DESCRIPTOR, 'utf8'); } catch { key = ''; }
  try {
    console.log(JSON.stringify(await listDomains({ key })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
