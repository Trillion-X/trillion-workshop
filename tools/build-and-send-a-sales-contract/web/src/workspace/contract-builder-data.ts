// tools/build-and-send-a-sales-contract/web/src/workspace/contract-builder-data.ts
//
// What the private deal builder reads, and nothing it writes: the pursuits (the vault's pursuit connections), and from
// the chosen pursuit's own database its customers (leads), its offers with price parts (offers, offer_price_parts) and
// its sender (email_sender). Every read is one tool:run-sql-in-my-database call through the door, with a statement
// time limit. The builder keeps its draft in the screen; nothing here saves a contract.

import focusWords from '../../../../workspace-screens/web/src/workspace/focus.json';
import { postJson } from '../../../../workspace-screens/web/src/workspace/api';
import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';
import { pursuitsFromNames } from '../../../../workspace-screens/web/src/workspace/pursuit-list.mjs';

const STATEMENT_MS = 5000;
const SQL_TOOL = 'tool:run-sql-in-my-database';

export type Pursuit = { id: string; title: string; connection: string };
export type Customer = { id: string; name: string | null; email: string };
export type Offer = { id: string; label: string };
export type PricePart = {
  id: string; piece: string; option_key: string; label: string; basis: 'flat' | 'per_unit' | 'percent' | 'at_cost';
  unit: string | null; amount_cents: number | null; percent: number | null; shown_publicly: boolean; position: number;
};
export type Sender = { name: string; from_address: string; reply_to: string | null; mailing_address: string | null; credential_name: string | null };

/** The pursuits the vault holds, by name (names only, never values). */
export async function readPursuits(): Promise<Pursuit[]> {
  const answer = await postJson<{ names?: unknown }>(focusWords.pursuits.names_method, {});
  if (!Array.isArray(answer?.names)) throw new Error(focusWords.pursuits.unreadable);
  return pursuitsFromNames(answer.names as string[]);
}

/** The database a pursuit's connection opens: the connection's name without its -connection suffix. */
const databaseOf = (pursuit: Pursuit) => pursuit.connection.replace(/-connection$/, '');
/** The pursuit's uses database (its runs database's name with the uses suffix, the same pattern the social screens read). */
const usesDatabaseOf = (pursuit: Pursuit) => databaseOf(pursuit).replace(/_for_who_runs_it$/, '_for_who_uses_it');

async function sql<T>(pursuit: Pursuit, text: string, params: unknown[] = [], database = databaseOf(pursuit)): Promise<T[]> {
  const ran = await runWorkshopTool<{ rows?: T[] }>(SQL_TOOL, { database, statement_timeout_ms: STATEMENT_MS, sql: text, params });
  return ran.result?.rows ?? [];
}

/** Customers whose name or email holds the search text (every customer when it is empty), newest first. */
export async function searchCustomers(pursuit: Pursuit, search: string): Promise<Customer[]> {
  const text = search.trim();
  return sql<Customer>(pursuit, 'select id, name, email from leads where ($1 = \'\' or name ilike $2 or email ilike $2) order by made_at desc nulls last limit 20', [text, `%${text}%`]);
}

/** The offers that have price parts, in the order the offers are sorted. */
export async function readOffers(pursuit: Pursuit): Promise<Offer[]> {
  return sql<Offer>(pursuit, 'select o.id, o.label from offers o where exists (select 1 from offer_price_parts p where p.offer = o.id) order by o.sort_order nulls last limit 50');
}

/** One offer's price parts, in their order. Amounts and percents come back as numbers. */
export async function readPriceParts(pursuit: Pursuit, offerId: string): Promise<PricePart[]> {
  const rows = await sql<Record<string, unknown>>(pursuit, 'select id, piece, option_key, label, basis, unit, amount_cents, percent, shown_publicly, position from offer_price_parts where offer = $1 order by position limit 200', [offerId]);
  return rows.map(row => ({
    id: String(row.id), piece: String(row.piece), option_key: String(row.option_key), label: String(row.label),
    basis: row.basis as PricePart['basis'], unit: (row.unit as string | null) ?? null,
    amount_cents: row.amount_cents === null || row.amount_cents === undefined ? null : Number(row.amount_cents),
    percent: row.percent === null || row.percent === undefined ? null : Number(row.percent),
    shown_publicly: row.shown_publicly === true, position: Number(row.position),
  }));
}

/** The pursuit's sender row (who the message is from), or null when it has none. */
export async function readSender(pursuit: Pursuit): Promise<Sender | null> {
  const [row] = await sql<Record<string, unknown>>(pursuit, 'select name, from_address, reply_to, mailing_address, credential_name from email_sender order by changed_at desc nulls last limit 1');
  if (!row) return null;
  return {
    name: String(row.from_address ?? '').replace(/<.*$/, '').trim() || String(row.name), from_address: String(row.from_address),
    reply_to: (row.reply_to as string | null) ?? null, mailing_address: (row.mailing_address as string | null) ?? null,
    credential_name: (row.credential_name as string | null) ?? null,
  };
}

/** The sender's address as the email tool takes it: its display name and its email. */
export function senderParts(sender: Sender): { name: string; email: string } {
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(sender.from_address);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { name: sender.name, email: sender.from_address.trim() };
}

/** The email tool's own composition of one message, sending nothing: the sender's key is the one its row names, through the
 *  keyed provider (the send tool mounts only the key the input names, and only for its owner). */
export async function dryRunWithEmailTool(sender: Sender, message: { to: string; subject: string; body: string }): Promise<{ from: string; to: string; subject: string; text: string | null }> {
  const parts = senderParts(sender);
  const ran = await runWorkshopTool<{ sent?: { composed?: { from: string; to: string; subject: string; text?: string }; error?: string }[] }>('tool:send-an-email', {
    provider: 'resend-keyed', key_name: sender.credential_name, dry_run: true, to: message.to, subject: message.subject, markdown: message.body,
    ...(sender.reply_to ? { reply_to: sender.reply_to } : {}), mail_settings: { from: parts, postal_address: sender.mailing_address },
  });
  const [only] = ran.result?.sent ?? [];
  if (!only?.composed) throw new Error(only?.error ?? ran.error ?? 'The email tool did not compose the message.');
  return { from: only.composed.from, to: only.composed.to, subject: only.composed.subject, text: only.composed.text ?? null };
}

/** The pursuit's look, from its own how_it_looks row (id 'site') in its uses database: the theme the page sets on its root,
 *  and the brand name and picture it shows. Null when the pursuit has no row, so the page keeps the shared look. */
export type Brand = { theme_id: string; brand_name: string | null; brand_image: string | null; icon: string | null };
export async function readBrand(pursuit: Pursuit): Promise<Brand | null> {
  const [row] = await sql<Record<string, unknown>>(pursuit, "select theme_id, brand_name, brand_image, icon from how_it_looks where id = 'site'", [], usesDatabaseOf(pursuit));
  if (!row || typeof row.theme_id !== 'string') return null;
  return { theme_id: row.theme_id, brand_name: (row.brand_name as string | null) ?? null, brand_image: (row.brand_image as string | null) ?? null, icon: (row.icon as string | null) ?? null };
}
