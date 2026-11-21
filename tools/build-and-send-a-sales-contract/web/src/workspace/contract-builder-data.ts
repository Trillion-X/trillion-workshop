// tools/build-and-send-a-sales-contract/web/src/workspace/contract-builder-data.ts
//
// What the private deal builder reads, and nothing it writes: the pursuits (the vault's pursuit connections), and from
// the chosen pursuit's own database its customers (leads), its offers with price parts (offers, offer_price_parts) and
// its sender (email_sender). Every read is one tool:run-sql-in-my-database call through the door, with a statement
// time limit. The builder keeps its draft in the screen; nothing here saves a contract.

import focusWords from './focus.json';
import { postJson } from './api';
import { runWorkshopTool } from './workshop-tool-api';
import { pursuitsFromNames } from './pursuit-list.mjs';

const STATEMENT_MS = 5000;
const SQL_TOOL = 'tool:run-sql-in-my-database';

export type Pursuit = { id: string; title: string; connection: string };
export type Customer = { id: string; name: string | null; email: string };
export type Offer = { id: string; label: string };
export type PricePart = {
  id: string; piece: string; option_key: string; label: string; basis: 'flat' | 'per_unit' | 'percent' | 'at_cost';
  unit: string | null; amount_cents: number | null; percent: number | null; shown_publicly: boolean; position: number;
};
export type Sender = { name: string; from_address: string; reply_to: string | null; mailing_address: string | null };

/** The pursuits the vault holds, by name (names only, never values). */
export async function readPursuits(): Promise<Pursuit[]> {
  const answer = await postJson<{ names?: unknown }>(focusWords.pursuits.names_method, {});
  if (!Array.isArray(answer?.names)) throw new Error(focusWords.pursuits.unreadable);
  return pursuitsFromNames(answer.names as string[]);
}

/** The database a pursuit's connection opens: the connection's name without its -connection suffix. */
const databaseOf = (pursuit: Pursuit) => pursuit.connection.replace(/-connection$/, '');

async function sql<T>(pursuit: Pursuit, text: string, params: unknown[] = []): Promise<T[]> {
  const ran = await runWorkshopTool<{ rows?: T[] }>(SQL_TOOL, { database: databaseOf(pursuit), statement_timeout_ms: STATEMENT_MS, sql: text, params });
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
  const [row] = await sql<Record<string, unknown>>(pursuit, 'select name, from_address, reply_to, mailing_address from email_sender order by changed_at desc nulls last limit 1');
  if (!row) return null;
  return { name: String(row.from_address ?? '').replace(/<.*$/, '').trim() || String(row.name), from_address: String(row.from_address), reply_to: (row.reply_to as string | null) ?? null, mailing_address: (row.mailing_address as string | null) ?? null };
}
