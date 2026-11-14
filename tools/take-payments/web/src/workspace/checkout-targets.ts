// tools/take-payments/web/src/workspace/checkout-targets.ts
//
// PURPOSE
//   Wires the buyer checkout screen to the Workshop: answers the three targets it asks (checkout-answers.ts, from the
//   tools checkout-targets.json names), and reads the person's own offer, eligibility and amount-choice rows through the
//   records door for the screen's offer list. The screen asked the retired Bitfield runtime for these; the web shell
//   answers a named target (`answerTarget`) and runs a tool through its one run owner (`runWorkshopTool`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every answer is a tool run through the page's one run owner; nothing here reaches Stripe or a key.
//   2. Rows are the person's own, read through the records door; nothing here lists a product or a price.
//   3. A buyer named by the screen's input is the only one whose held access is asked for.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { answerTarget } from '#workspace-records';
import { listRecords } from '#workspace/records-door';
import { newRunKey, runWorkshopTool } from '#workspace/workshop-tool-api';
import { readCheckoutOffers, type CheckoutOffer, type SuggestionLists } from '../../../../funnels-and-offers/read-data/read-offers';
import { suggestionListsOf } from '../../../read-data/suggestion-lists.mjs';
import targets from './checkout-targets.json' with { type: 'json' };
import { completeAnswer, heldRefsAnswer, prepareAnswer, startAnswer, type CheckoutContext, type RunTool } from './checkout-answers';

type Row = Record<string, unknown>;

const run: RunTool = (tool, input) => runWorkshopTool(tool, input, newRunKey('checkout')) as Promise<{ result?: unknown }>;

let context: CheckoutContext = { sellerConnection: targets.seller_connection, origin: '', path: '', store: null };

/** The rows of one kind the person keeps, as the values the offer readers take (a row without a `kind` takes the declared one). */
async function rowsOf({ type, kind }: { type: string; kind: string }): Promise<Row[]> {
  return (await listRecords({ type })).flatMap(record => (record.value && typeof record.value === 'object' ? [{ kind, ...record.value }] : []));
}

const doorOf = { list: async function* ({ type }: { type: string }) { for (const record of await listRecords({ type })) yield record; } };

async function routeOf(offerId: string): Promise<string | undefined> {
  const rows = await rowsOf(targets.offers);
  return readCheckoutOffers(rows, { suggestionLists: await suggestionListsOf(rows, doorOf) }).find(offer => offer.id === offerId)?.post_purchase_route_path;
}

/** Answer the checkout targets this page serves, for the buyer and seller connection the screen names. */
export function answerCheckoutTargets(input: { sellerConnection?: string; subject?: string } = {}) {
  context = {
    sellerConnection: input.sellerConnection || targets.seller_connection,
    origin: window.location.origin,
    path: window.location.pathname,
    ...(input.subject ? { subject: input.subject } : {}),
    routeOf,
    store: window.sessionStorage,
  };
  answerTarget(targets.prepare.target, payload => prepareAnswer(payload, run));
  answerTarget(targets.start.target, payload => startAnswer(payload, run, context));
  answerTarget(targets.complete.target, payload => completeAnswer(payload, run, context));
}

/** The offers the person sells, with the suggested amounts their choice rows give; null until read. */
export function useCheckoutOffers(): CheckoutOffer[] | null {
  const [offers, setOffers] = React.useState<CheckoutOffer[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await rowsOf(targets.offers);
      const lists: SuggestionLists = await suggestionListsOf(rows, doorOf);
      if (!cancelled) setOffers(readCheckoutOffers(rows, { suggestionLists: lists }));
    })();
    return () => { cancelled = true; };
  }, []);
  return offers;
}

/** The person's offer eligibility rows, read when the screen opens. */
export function useEligibilityRows(): Row[] {
  const [rows, setRows] = React.useState<Row[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void rowsOf(targets.eligibility).then(found => { if (!cancelled) setRows(found); });
    return () => { cancelled = true; };
  }, []);
  return rows;
}

/** The access refs the named buyer holds now (none when the screen names no buyer). */
export function readHeldAccessRefs(): Promise<string[]> {
  return heldRefsAnswer(run, context);
}
