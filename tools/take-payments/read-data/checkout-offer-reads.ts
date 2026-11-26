// tools/take-payments/read-data/checkout-offer-reads.ts
//
// PURPOSE
//   The checkout's own read of a pursuit's offers: when tool:start-a-stripe-checkout is given a `database` (and no `offers`), it
//   reads the offers and their suggested-amount rows itself, so a caller such as a site's action row hands it nothing but the
//   buyer's choice. The tables and columns read are declared once, in reader-rights.json beside this file: the reads file that
//   a computer row's database unit names in a reader's grants reads_from, so the reader login's grant is rendered from the same
//   declaration these statements are made from. This file only turns that declaration into the two statements.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the tables and columns of reader-rights.json are read, in two plain SELECTs with no parameter; nothing is written.
//      A column the checkout stops reading comes out of that file, and so out of both the statement and the grant.
//   2. The answer is what the caller would have handed in: `offers` the offers rows as read, `suggestions` the suggested-amount
//      rows with `multiple` as a number (the database keeps it as numeric, which its driver answers as text).
//   3. Nothing here holds a login, a client or a descriptor: the rows are read through the `rows` function it is handed
//      (run-sql-in-my-database/do-work/serve-a-read.ts readInDatabase in a run).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import readerRights from './reader-rights.json' with { type: 'json' };

export type Rows = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
export type CheckoutLists = { offers: Record<string, unknown>[]; suggestions: Record<string, unknown>[] };
type Read = { table: string; columns: readonly string[] };

// Which list each declared table answers. `multiple` is read as a number (cast in the statement).
const LIST_OF_TABLE = { 'public.offers': 'offers', 'public.offer_amount_choices': 'suggestions' } as const;
const NUMBER_COLUMNS = new Set(['multiple']);
const NAME = /^[a-z_][a-z0-9_]*$/;

function readOf(table: keyof typeof LIST_OF_TABLE): Read {
  const read = (readerRights.reads as Read[]).find(item => item.table === table);
  if (!read || read.columns.length === 0) throw new Error(`reader-rights.json declares no read of ${table}.`);
  return read;
}

// The declared reads, by the list each answers (from reader-rights.json, and nothing else).
export const CHECKOUT_OFFER_READS = { offers: readOf('public.offers'), suggestions: readOf('public.offer_amount_choices') };

// The statement of one declared read: its columns as declared (a number column cast to float8, so it is answered as a number).
export function statementOf(read: Read): string {
  const [schema, table] = read.table.split('.');
  if (![schema, table, ...read.columns].every(name => NAME.test(name ?? ''))) throw new Error(`${read.table}: a declared read names only plain table and column names.`);
  const columns = read.columns.map(column => (NUMBER_COLUMNS.has(column) ? `${column}::float8 AS ${column}` : column));
  return `SELECT ${columns.join(', ')} FROM ${schema}.${table}`;
}

/** Reads the offers and the suggested-amount rows a checkout prices from, as reader-rights.json declares them. */
export async function readCheckoutLists(_input: unknown, rows: Rows): Promise<CheckoutLists> {
  const [offers, suggestions] = [await rows(statementOf(CHECKOUT_OFFER_READS.offers)), await rows(statementOf(CHECKOUT_OFFER_READS.suggestions))];
  return { offers, suggestions };
}
