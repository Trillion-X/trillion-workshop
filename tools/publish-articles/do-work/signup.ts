// tools/publish-articles/do-work/signup.ts
//
// PURPOSE
//   Double opt-in for a pursuit's newsletter, as a plan. `planSignup` reads the address's row and answers what to write and
//   what to send: the statements for tool:run-sql-in-my-database and the confirmation message for tool:send-an-email. Nothing
//   is sent or written here; a person gets only the confirmation message until the link in it is opened. `planConfirm`
//   decides what opening the link does.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a keyed-by-random-token digest of the confirmation token is kept; the token itself is only in the message.
//   2. An address that is already confirmed is told nothing new and gets no message; an unsubscribed one starts again.
//   3. A confirmation link works once and for `CONFIRM_WITHIN_MS`; the row must be pending and its digest must match.
//   4. The consent wording shown, the page and the time are stored as given, never an address of the network.
//   5. Table and column names live in TABLES below and nowhere else.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createHash, randomBytes } from 'node:crypto';
import type { Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';

export const TABLES = { subscribers: 'subscribers' } as const;
export const CONFIRM_WITHIN_MS = 48 * 60 * 60 * 1000;
const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export type SignupInput = {
  database: string; email: string; source_path: string; consent_text: string; confirm_origin: string;
  confirm: { subject: string; body: string }; tags?: string[]; now?: string; random_token?: string; id?: string;
};
export type Statement = { sql: string; params: unknown[] };
export type SignupPlan =
  | { action: 'already_confirmed' | 'refused'; reason?: string; statements: []; message: null }
  | { action: 'send_confirmation'; statements: Statement[]; message: { to: string; subject: string; text: string } };

export const digestOf = (id: string, token: string): string => createHash('sha256').update(`confirm\n${id}:${token}`).digest('base64url');

export function planSignupFrom(input: SignupInput, existing: Record<string, unknown> | undefined): SignupPlan {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email) || email.length > 254) return { action: 'refused', reason: 'That address does not look right.', statements: [], message: null };
  if (existing?.status === 'confirmed') return { action: 'already_confirmed', statements: [], message: null };
  if (existing && existing.status !== 'pending' && existing.status !== 'unsubscribed') return { action: 'refused', reason: 'This address cannot be signed up.', statements: [], message: null };
  const origin = new URL(input.confirm_origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/') throw new TypeError('confirm_origin must be an https origin with no path.');
  const now = input.now ?? new Date().toISOString();
  const token = input.random_token ?? randomBytes(32).toString('base64url');
  const id = typeof existing?.id === 'string' ? existing.id : input.id ?? `subscriber-${randomBytes(12).toString('base64url')}`;
  const tags = JSON.stringify([...new Set(input.tags ?? [])].sort());
  const digest = digestOf(id, token);
  const t = TABLES.subscribers;
  const statements: Statement[] = existing
    ? [{ sql: `UPDATE ${t} SET status = 'pending', confirm_digest = $1, confirm_sent_at = $2, source_path = $3, confirmed_at = NULL, ended_at = NULL, ended_reason = NULL, consent_text = $4, consent_at = $2, consent_page = $3, tags = $5 WHERE id = $6 AND status IN ('pending', 'unsubscribed')`,
        params: [digest, now, input.source_path, input.consent_text, tags, id] }]
    : [{ sql: `INSERT INTO ${t} (id, email, status, confirm_digest, confirm_sent_at, source_path, created_at, tags, consent_text, consent_at, consent_page) VALUES ($1, $2, 'pending', $3, $4, $5, $4, $6, $7, $4, $5)`,
        params: [id, email, digest, now, input.source_path, tags, input.consent_text] }];
  const link = new URL('/subscribe/confirm', origin);
  link.searchParams.set('s', id);
  link.searchParams.set('t', token);
  return { action: 'send_confirmation', statements, message: { to: email, subject: input.confirm.subject, text: `${input.confirm.body}\n\n${link.href}` } };
}

export const planSignup: Reader<SignupInput, SignupPlan> = async (input, rows) => {
  const [existing] = await rows(`SELECT id, status FROM ${TABLES.subscribers} WHERE email = $1`, [input.email.trim().toLowerCase()]);
  return planSignupFrom(input, existing);
};

export type ConfirmPlan = { action: 'confirm' | 'already_confirmed' | 'invalid'; statements: Statement[] };

export function planConfirmFrom(input: { id: string; token: string; now?: string }, row: Record<string, unknown> | undefined): ConfirmPlan {
  if (row?.status === 'confirmed') return { action: 'already_confirmed', statements: [] };
  const now = input.now ?? new Date().toISOString();
  const sent = typeof row?.confirm_sent_at === 'string' || row?.confirm_sent_at instanceof Date ? Date.parse(String(row.confirm_sent_at instanceof Date ? row.confirm_sent_at.toISOString() : row.confirm_sent_at)) : NaN;
  const fresh = Number.isFinite(sent) && Date.parse(now) - sent <= CONFIRM_WITHIN_MS;
  if (!(row?.status === 'pending' && fresh && row.confirm_digest === digestOf(input.id, input.token))) return { action: 'invalid', statements: [] };
  return { action: 'confirm', statements: [{ sql: `UPDATE ${TABLES.subscribers} SET status = 'confirmed', confirmed_at = $1, confirm_digest = NULL WHERE id = $2 AND status = 'pending' AND confirm_digest = $3`, params: [now, input.id, row.confirm_digest] }] };
}

export const planConfirm: Reader<{ database: string; id: string; token: string; now?: string }, ConfirmPlan> = async (input, rows) => {
  const [row] = await rows(`SELECT id, status, confirm_digest, confirm_sent_at FROM ${TABLES.subscribers} WHERE id = $1`, [input.id]);
  return planConfirmFrom(input, row);
};
