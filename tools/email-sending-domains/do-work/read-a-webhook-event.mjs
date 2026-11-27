import { realpathSync } from 'node:fs';
// tools/email-sending-domains/do-work/read-a-webhook-event.mjs
//
// The container tool `tool:read-a-webhook-event` (what-this-tool-does-and-how-to-run-it.json): one event the person's email-sending account (Resend) sent
// to one of its webhooks, by the webhook's id and the event's id (msg_...): its type, time, delivery status, the email it is
// about and, for a bounce, the bounce's type (Permanent or Temporary) and sub-type. It only reads.
//
// The account key reaches this one process on a private pipe, descriptor 3 (the row's invoke.key { fd: 3 }),
// never in the request, argv, a file or the environment. This command asks GET /webhooks/{webhook_id}/events/{event_id} once
// and answers those fields only: never the key, the addressees, the subject or the provider's raw reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADDRESS = 'https://api.resend.com/webhooks/';
const KEY_DESCRIPTOR = 3;
const WEBHOOK_ID = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_ID = /^msg_[A-Za-z0-9]{1,64}$/;

// One webhook event: { id, type, created_at, status, email_id, bounce: { type, sub_type } | null }.
export async function readWebhookEvent({ key, webhook_id, event_id, fetchImpl = fetch }) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('No email-sending key was handed to this run. Connect the email-sending account first.');
  if (typeof webhook_id !== 'string' || !WEBHOOK_ID.test(webhook_id)) throw new Error('The webhook id is letters, digits and dashes only, as tool:list-resend-webhooks answers it.');
  if (typeof event_id !== 'string' || !EVENT_ID.test(event_id)) throw new Error('The event id starts msg_ and then letters and digits, as tool:list-webhook-events answers it.');
  const response = await fetchImpl(`${ADDRESS}${webhook_id}/events/${event_id}`, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error(`The email-sending account refused the held key (${response.status}). Connect the account again with a key that may read webhooks (full access).`);
  if (response.status === 404) throw new Error(`The email-sending account has no event ${event_id} on webhook ${webhook_id}.`);
  if (!response.ok) throw new Error(`The email-sending account answered ${response.status}. Try again later.`);
  const event = await response.json();
  const data = event?.payload?.data ?? {};
  const bounce = data?.bounce && typeof data.bounce === 'object' ? { type: String(data.bounce.type ?? 'unknown'), sub_type: String(data.bounce.subType ?? 'unknown') } : null;
  return {
    id: String(event?.id ?? event_id),
    type: String(event?.type ?? event?.payload?.type ?? ''),
    created_at: String(event?.created_at ?? event?.payload?.created_at ?? ''),
    status: String(event?.status ?? 'unknown'),
    email_id: String(data?.email_id ?? ''),
    bounce,
  };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let key = '';
  try { key = readFileSync(KEY_DESCRIPTOR, 'utf8'); } catch { key = ''; }
  try {
    const { webhook_id, event_id } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await readWebhookEvent({ key, webhook_id, event_id })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
