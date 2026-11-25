import { realpathSync } from 'node:fs';
// tools/email-sending-domains/do-work/read-a-sent-email.mjs
//
// The container tool `tool:read-a-sent-email` (tool-rows.json): one email the person's email-sending account (Resend) sent,
// by its id, and the last thing that happened to it (sent, delivered, bounced, opened, clicked, complained). It only reads.
//
// The account key reaches this one process on a private pipe, descriptor 3 (the row's invoke.credential_mounts { fd: 3 }),
// never in the request, argv, a file or the environment. This command asks GET /emails/{email_id} once and answers the
// email's id, sender, addressees, subject, when it was sent and its last event only: never the key, the email's body or the
// provider's raw reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADDRESS = 'https://api.resend.com/emails/';
const KEY_DESCRIPTOR = 3;
const EMAIL_ID = /^[A-Za-z0-9-]{1,64}$/;

// One sent email: { id, from, to, subject, created_at, last_event }.
export async function readSentEmail({ key, email_id, fetchImpl = fetch }) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('No email-sending key was handed to this run. Connect the email-sending account first.');
  if (typeof email_id !== 'string' || !EMAIL_ID.test(email_id)) throw new Error('The email id is letters, digits and dashes only, as the account gave it when it sent the email.');
  const response = await fetchImpl(`${ADDRESS}${email_id}`, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 401 || response.status === 403) throw new Error(`The email-sending account refused the held key (${response.status}). Connect the account again with a key that may read emails (full access).`);
  if (response.status === 404) throw new Error(`The email-sending account has no email ${email_id}.`);
  if (!response.ok) throw new Error(`The email-sending account answered ${response.status}. Try again later.`);
  const email = await response.json();
  return {
    id: String(email?.id ?? email_id),
    from: String(email?.from ?? ''),
    to: Array.isArray(email?.to) ? email.to.map(String) : [],
    subject: String(email?.subject ?? ''),
    created_at: String(email?.created_at ?? ''),
    last_event: String(email?.last_event ?? 'unknown'),
  };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let key = '';
  try { key = readFileSync(KEY_DESCRIPTOR, 'utf8'); } catch { key = ''; }
  try {
    const { email_id } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await readSentEmail({ key, email_id })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
