// tools/serve-articles-and-signup/routes/keep-a-newsletter-signup.ts
//
// PURPOSE
//   The three newsletter routes of a pursuit's site as one tool, ported from pursuit-site.mjs (subscribe, confirm, unsubscribe): the
//   double opt-in over the pursuit's `subscribers` rows. `action` says which: `subscribe` (POST /subscribe) keeps a pending signup and
//   answers the confirmation mail to send; `confirm` (GET /subscribe/confirm) confirms a pending signup from its link; `unsubscribe`
//   (GET or POST /unsubscribe) ends a subscription from its link; `send_failed` puts a pending signup back when its mail could not be
//   sent. The tool answers an outcome, never a page: the site row draws the words. It sends no mail itself and holds no mail key:
//   `mail` in the answer (to, subject, text, and the link with its button words) is sent by the caller's mail tool.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nobody is sent anything but the confirmation mail until the confirm link is used (double opt-in); the link is good for 72
//      hours and for one use; a suppression (a bounce or complaint) is never renewed.
//   2. An unsubscribe link carries a keyed digest of the subscriber id, so one link ends that subscription and no other.
//   3. A raw address of the network is never kept: the network and the consent address are kept as keyed digests.
//   4. Each action's writes are one statement, so each is kept whole or not at all.
//   5. The secret is the held key the engine mounts on descriptor 4; it never appears in an answer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sayWithout, withSqlWrite } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import type { Execute } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';
import { subscriberTags } from '../do-work/subscriber-audience.mjs';

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const SIGNUPS_PER_NETWORK_PER_HOUR = 5;
const CONFIRM_HOURS = 72;

export type SignupText = { consent: string; confirm: { subject: string; body: string; button: string } };
export type Given = {
  action: 'subscribe' | 'confirm' | 'unsubscribe' | 'send_failed';
  secret: string; origin: string;
  email?: string; source?: string; ip?: string; forwarded_for?: string; signup?: SignupText; tags?: string[]; source_tags?: Record<string, string[]>;
  s?: string; t?: string; method?: string; id?: string; digest?: string;
};
export type Outcome = { outcome: string; mail?: { to: string; subject: string; text: string; link: string; button: string }; attempt?: { id: string; digest: string } };
type Clock = { now?: () => string; newId?: () => string; newToken?: () => string };

// Every write is one statement of `execute`, so it is whole or not at all.
export async function keepANewsletterSignup(input: Given, execute: Execute, { now = () => new Date().toISOString(), newId = () => randomUUID(), newToken = () => randomBytes(24).toString('base64url') }: Clock = {}): Promise<Outcome> {
  const { secret } = input;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('The signup key is not held.');
  const keyed = (purpose: string, value: string) => createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');
  const text = (value: unknown) => (typeof value === 'string' ? value : '');

  if (input.action === 'confirm') {
    const id = text(input.s), token = text(input.t);
    const [row] = await execute('SELECT * FROM subscribers WHERE id = $1', [id]) as any[];
    if (row?.status === 'confirmed') return { outcome: 'already_subscribed' };
    const age = row ? Date.parse(now()) - Date.parse(row.confirm_sent_at) : NaN;
    if (!(row?.status === 'pending' && age >= 0 && age < CONFIRM_HOURS * 3600_000 && row.confirm_digest === keyed('confirm', `${id}:${token}`))) return { outcome: 'invalid_link' };
    const changed = await execute("UPDATE subscribers SET status = 'confirmed', confirmed_at = $1, confirm_digest = NULL WHERE id = $2 AND status = 'pending' AND confirm_digest = $3 RETURNING id", [now(), id, row.confirm_digest]);
    return { outcome: changed.length ? 'subscribed' : 'invalid_link' };
  }

  if (input.action === 'unsubscribe') {
    const id = text(input.s), token = text(input.t);
    const [row] = await execute('SELECT id, status FROM subscribers WHERE id = $1', [id]) as any[];
    if (!row || token !== keyed('unsubscribe', id)) return { outcome: 'invalid_link' };
    if (row.status === 'confirmed' || row.status === 'pending') {
      await execute("UPDATE subscribers SET status = 'unsubscribed', ended_at = $1, ended_reason = $2 WHERE id = $3 AND status IN ('confirmed', 'pending') RETURNING id", [now(), input.method === 'POST' ? 'one-click' : 'link', id]);
    }
    return { outcome: 'unsubscribed' };
  }

  if (input.action === 'send_failed') {
    await execute("UPDATE subscribers SET confirm_sent_at = NULL WHERE id = $1 AND status = 'pending' AND confirm_digest = $2 RETURNING id", [text(input.id), text(input.digest)]);
    return { outcome: 'send_failed' };
  }

  if (input.action !== 'subscribe') throw new Error('action is subscribe, confirm, unsubscribe or send_failed.');
  const signup = input.signup;
  if (!signup?.consent || !signup.confirm?.subject || !signup.confirm.body || !signup.confirm.button) throw new Error('Give signup: the consent words and the confirmation mail words.');
  const origin = text(input.origin);
  if (!/^https:\/\//.test(origin)) throw new Error('Give origin: the site\'s https address.');
  const email = text(input.email).trim().toLowerCase();
  const given = text(input.source);
  const source = given.startsWith('/') && !given.startsWith('//') && !/[\\\r\n]/.test(given) ? given.slice(0, 200) : '/';
  if (!EMAIL_SHAPE.test(email) || email.length > 254) return { outcome: 'invalid_email' };
  const network = keyed('network', text(input.ip) || text(input.forwarded_for) || 'unknown');
  const since = new Date(Date.parse(now()) - 3600_000).toISOString();
  const [{ n }] = await execute('SELECT count(*)::int AS n FROM subscribers WHERE network_digest = $1 AND confirm_sent_at > $2', [network, since]) as any[];
  if (Number(n) >= SIGNUPS_PER_NETWORK_PER_HOUR) return { outcome: 'too_many' };
  const [existing] = await execute('SELECT * FROM subscribers WHERE email = $1', [email]) as any[];
  const base = subscriberTags(input.tags ?? []);
  const sourceTags = subscriberTags((input.source_tags ?? {})[source] ?? []);
  const tagsFor = (existingTags: unknown) => subscriberTags([...subscriberTags((existingTags as string[]) ?? []), ...base, ...sourceTags]);
  if (existing?.status === 'confirmed') {
    await execute("UPDATE subscribers SET tags = $1 WHERE id = $2 AND status = 'confirmed' RETURNING id", [JSON.stringify(tagsFor(existing.tags ?? [])), existing.id]);
    return { outcome: 'check_inbox' };
  }
  // Only a pending signup or a deliberate re-opt-in may be renewed. A suppression (including a bounce or complaint) never is.
  if (existing && existing.status !== 'pending' && existing.status !== 'unsubscribed') return { outcome: 'check_inbox' };
  const id = existing?.id ?? newId();
  const tags = JSON.stringify(tagsFor(existing?.tags ?? []));
  const token = newToken();
  const at = now();
  const digest = keyed('confirm', `${id}:${token}`);
  const ip = keyed('ip', text(input.ip) || 'unknown');
  const changed = existing
    ? await execute(`UPDATE subscribers SET status = 'pending', confirm_digest = $1, confirm_sent_at = $2, source_path = $3, network_digest = $4,
        confirmed_at = NULL, ended_at = NULL, ended_reason = NULL, consent_text = $5, consent_at = $6, consent_page = $7, consent_ip_digest = $8, tags = $9
        WHERE id = $10 AND status IN ('pending', 'unsubscribed') RETURNING id`, [digest, at, source, network, signup.consent, at, source, ip, tags, id])
    : await execute(`INSERT INTO subscribers (id, email, status, confirm_digest, confirm_sent_at, source_path, network_digest, created_at, tags,
        consent_text, consent_at, consent_page, consent_ip_digest) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $4, $7, $8, $9, $10, $11)
        ON CONFLICT (email) DO NOTHING RETURNING id`, [id, email, digest, at, source, network, tags, signup.consent, at, source, ip]);
  if (!changed.length) return { outcome: 'check_inbox' };
  const link = new URL(`/subscribe/confirm?s=${encodeURIComponent(id)}&t=${token}`, origin).toString();
  return { outcome: 'send_confirmation', attempt: { id, digest }, mail: { to: email, subject: signup.confirm.subject, text: `${signup.confirm.body}\n\n${link}`, link, button: signup.confirm.button } };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '';
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as Given;
    connection = readFileSync(3, 'utf8').trim();
    const secret = readFileSync(4, 'utf8').trim();
    // One connection for the whole run (run-sql.mjs withSqlWrite), closed at the end.
    const kept = await withSqlWrite({ connection }, (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => {
      const execute: Execute = async (sql, params = []) => (await query(sql, params)).rows;
      return keepANewsletterSignup({ ...input, secret }, execute);
    });
    console.log(JSON.stringify(kept));
  } catch (error) {
    console.error(sayWithout(error, connection));
    process.exitCode = 1;
  }
}
