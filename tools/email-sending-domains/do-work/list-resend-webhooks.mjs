import { realpathSync } from 'node:fs';
// tools/email-sending-domains/do-work/list-resend-webhooks.mjs
//
// The container tool `tool:list-resend-webhooks` (what-this-tool-does-and-how-to-run-it.json): which addresses the person's email-sending account
// (Resend) sends its email events to, each one's state and the events it asks for. It only reads; it changes no webhook.
//
// The account key is never in the request, argv, a file or the environment: the engine hands the person's own held key to
// this one process on a private pipe, descriptor 3 (the row's invoke.key { fd: 3 }), and the pipe ends after
// the key. This command reads it, asks the provider's webhook list once, and answers each webhook's id, address, state and
// events and the count only: never the key, a header, a webhook's signing secret or the provider's raw reply (the list
// gives no secret; only one webhook's own read does, and this tool never makes that read).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADDRESS = 'https://api.resend.com/webhooks';
const KEY_DESCRIPTOR = 3;

// The webhooks the key's account holds: { webhooks: [{ id, url, status, events }], count }.
export async function listWebhooks({ key, fetchImpl = fetch }) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('No email-sending key was handed to this run. Connect the email-sending account first.');
  const response = await fetchImpl(ADDRESS, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error(`The email-sending account refused the held key (${response.status}). Connect the account again with a key that may read webhooks (full access).`);
  if (!response.ok) throw new Error(`The email-sending account answered ${response.status}. Try again later.`);
  const body = await response.json();
  const webhooks = (Array.isArray(body?.data) ? body.data : []).map(webhook => ({
    id: String(webhook?.id ?? ''),
    url: String(webhook?.endpoint ?? ''),
    status: String(webhook?.status ?? 'unknown'),
    events: Array.isArray(webhook?.events) ? webhook.events.map(String) : [],
  }));
  return { webhooks, count: webhooks.length };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let key = '';
  try { key = readFileSync(KEY_DESCRIPTOR, 'utf8'); } catch { key = ''; }
  try {
    console.log(JSON.stringify(await listWebhooks({ key })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
