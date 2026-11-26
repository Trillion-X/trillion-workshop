// tools/take-payments/reads/start-a-checkout-reading-its-offers.ts
//
// PURPOSE
//   The function tool:start-a-stripe-checkout runs. It is take-payments.mjs's startAStripeCheckout, with one more road in: given
//   a `database` and no `offers`, it first reads the pursuit's offers and suggested-amount rows itself
//   (read-data/checkout-offer-reads.ts, the columns read-data/reader-rights.json declares) and hands them on as if the caller had,
//   so a caller such as a site's action row sends nothing but the buyer's choice. It lives outside do-work, which every
//   take-payments row packs, so only the row that reads a database packs it and run-sql's read; every other row is as before.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A request that carries `offers` is handed to take-payments.mjs's startAStripeCheckout as it is: nothing is read, nothing
//      changes for any caller that hands its lists in.
//   2. Given a `database` and no `offers`: the database's connection is the one the row mounts on descriptor 6 and, under a
//      declared `use`, the use ticket on descriptor 7; the read is run-sql's readInDatabase (one read transaction that claims the
//      use first, under the reader login the use opens). A read that is refused stops the checkout before Stripe is asked
//      anything, and its reason is told without the connection or the ticket.
//   3. A checkout reads offers only under a use, and only through the database's reader login: given a `database` and no `use`,
//      it is refused in these words before any descriptor is read or Stripe is asked anything. The row mounts the reader login
//      (-reader-connection) on 6 whether or not a use is given, so the owner's login is never handed to this run; under a use the
//      engine also hands the use ticket on 7, which the read's transaction claims first.
//   4. `context.readOffers`, when given (tests), stands in for the descriptor read; nothing else of the context is read here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync } from 'node:fs';
import { startAStripeCheckout as startWithLists } from '../do-work/take-payments.mjs';
import { readCheckoutLists, type CheckoutLists } from '../read-data/checkout-offer-reads.ts';
import { readInDatabase } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { sayWithout } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

const DATABASE_DESCRIPTOR = 6;
const NO_USE = 'A checkout reads offers only under a use.';
const TICKET_DESCRIPTOR = 7;

type Given = Record<string, unknown> & { offers?: unknown; database?: unknown; use?: unknown };
type ReadOffers = (input: Given & { database: string }) => Promise<CheckoutLists>;

/** Starts a Stripe Checkout as take-payments.mjs does, reading the offers from `database` first when none are handed in. */
export async function startAStripeCheckout(given: Given, context: { readOffers?: ReadOffers } & Record<string, unknown> = {}) {
  if (Array.isArray(given.offers) || typeof given.database !== 'string' || given.database === '') return startWithLists(given, context);
  if (!isUse(given.use)) throw new Error(`${NO_USE} Give use ({ purpose, surface }) with database ${given.database}, or hand the offers in.`);
  const read = context.readOffers ?? readOffersFromDescriptors;
  let lists: CheckoutLists;
  try {
    lists = await read(given as Given & { database: string });
  } catch (error) {
    throw new Error(`The offers could not be read from ${given.database}: ${(error as Error)?.message ?? error}`);
  }
  return startWithLists({ ...given, offers: lists.offers, suggestions: lists.suggestions }, context);
}

function isUse(use: unknown): boolean {
  return !!use && typeof use === 'object' && !Array.isArray(use) && typeof (use as { purpose?: unknown }).purpose === 'string' && (use as { purpose: string }).purpose !== '';
}

// The run's own read: the connection and ticket the row mounted, through run-sql's one read seam, told without either.
async function readOffersFromDescriptors(input: Given & { database: string }): Promise<CheckoutLists> {
  let connection = '', ticket = '';
  try {
    connection = readFileSync(DATABASE_DESCRIPTOR, 'utf8').trim();
    ticket = readFileSync(TICKET_DESCRIPTOR, 'utf8').trim();
    return await readInDatabase(input as never, readCheckoutLists, { connection, ticket });
  } catch (error) {
    throw new Error(sayWithout(error, connection, ticket));
  }
}
