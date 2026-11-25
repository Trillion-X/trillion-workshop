import { realpathSync } from 'node:fs';
// tools/email-sending-domains/do-work/list-sent-emails.mjs
//
// The container tool `tool:list-sent-emails` (tool-rows.json): the emails the person's email-sending account (Resend) sent in
// the last few days, newest first, each with the last thing that happened to it. It only reads.
//
// The account key reaches this one process on a private pipe, descriptor 3 (the row's invoke.credential_mounts { fd: 3 }),
// never in the request, argv, a file or the environment. This command asks GET /emails a page at a time (at most MOST_PAGES
// pages of 100) until it reaches an email older than the window, and answers each email's id, addressees, subject, when it
// was sent and its last event, and the count: never the key, a body or the provider's raw reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ADDRESS = 'https://api.resend.com/emails';
const KEY_DESCRIPTOR = 3;
const PAGE = 100;
const MOST_PAGES = 50;
const DAY_MS = 86400000;

// Resend writes times as "2026-11-25 14:45:46.162+00"; Date reads them once the space is a T and the offset has its minutes.
const when = text => Date.parse(String(text ?? '').replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));

// The emails sent in the last `days` days: { emails: [{ id, to, subject, created_at, last_event }], count, complete }.
export async function listSentEmails({ key, days, now = Date.now(), fetchImpl = fetch }) {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('No email-sending key was handed to this run. Connect the email-sending account first.');
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('days is a whole number from 1 to 30.');
  const since = now - days * DAY_MS;
  const emails = [];
  let after = null;
  for (let page = 0; page < MOST_PAGES; page += 1) {
    const address = `${ADDRESS}?limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const response = await fetchImpl(address, { headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (response.status === 401 || response.status === 403) throw new Error(`The email-sending account refused the held key (${response.status}). Connect the account again with a key that may read emails (full access).`);
    if (!response.ok) throw new Error(`The email-sending account answered ${response.status}. Try again later.`);
    const body = await response.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const email of data) {
      if (!(when(email?.created_at) >= since)) return { emails, count: emails.length, complete: true };
      emails.push({
        id: String(email?.id ?? ''),
        to: Array.isArray(email?.to) ? email.to.map(String) : [],
        subject: String(email?.subject ?? ''),
        created_at: String(email?.created_at ?? ''),
        last_event: String(email?.last_event ?? 'unknown'),
      });
    }
    if (!body?.has_more || data.length === 0) return { emails, count: emails.length, complete: true };
    after = String(data[data.length - 1]?.id ?? '');
  }
  return { emails, count: emails.length, complete: false };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let key = '';
  try { key = readFileSync(KEY_DESCRIPTOR, 'utf8'); } catch { key = ''; }
  try {
    const { days } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    console.log(JSON.stringify(await listSentEmails({ key, days })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
