// tools/take-payments/web/src/workspace/checkout-answers.ts
//
// PURPOSE
//   What the buyer checkout screen's three targets answer with, worked out by the Workshop tools that own each job
//   (checkout-targets.json says which): the amount and plan to show (tool:price-a-sale), the Stripe checkout a paid
//   choice is sent to (tool:start-a-stripe-checkout), and whether a returning buyer's checkout was paid
//   (tool:look-up-a-stripe-checkout). The old checkout package answered these three from its engine
//   (do-work/gate-checkout.ts); that engine's signed events, account derivation and quote reservations are not carried,
//   because a payment is believed from Stripe's own record and what a buyer holds is worked out from payment events
//   each time (tools/paid-access). This file takes the run as a parameter so it holds no page, no tool name and no
//   network of its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A price is always the tool's: nothing here adds, rounds or picks an amount.
//   2. A redirect never grants access: the return only asks Stripe, through the tool, whether the checkout was paid.
//   3. Free means the quote asks for nothing today and nothing later: only then does a start skip Stripe.
//   4. Only the fields a tool takes are sent to it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import targets from './checkout-targets.json' with { type: 'json' };

export type RunTool = (tool: string, input: Record<string, unknown>) => Promise<{ result?: unknown }>;

export type CheckoutContext = {
  /** The seller's Stripe connection the paid steps use (service_connection:stripe is the person's own). */
  sellerConnection: string;
  /** Where the buyer's browser is: its origin and the path of this screen. */
  origin: string;
  path: string;
  /** The buyer, the way the person's access rules name one; none means nothing is held. */
  subject?: string;
  /** The page the person's offer says to open after paying, for one offer (its `post_purchase_route_path`). */
  routeOf?: (offerId: string) => Promise<string | undefined>;
  /** Where the route to open after paying waits for the return (sessionStorage). */
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = (input: unknown, keys: readonly string[]): Row => {
  const from = isRow(input) ? input : {};
  return Object.fromEntries(keys.filter(key => from[key] !== undefined).map(key => [key, from[key]]));
};

const resultOf = (ran: { result?: unknown }, tool: string): Row => {
  if (!isRow(ran?.result)) throw new Error(`${tool} answered nothing.`);
  return ran.result;
};

const zero = (cents: unknown) => { try { return BigInt(String(cents ?? '0')) === 0n; } catch { return false; } };

const routeKey = (sessionId: string) => `checkout-route:${sessionId}`;

/** checkout.prepare-checkout: the material (amount due today, what repeats, access refs, code notice) for one choice. */
export async function prepareAnswer(payload: unknown, run: RunTool): Promise<Row> {
  const { tool, takes } = targets.prepare;
  const priced = resultOf(await run(tool, pick(payload, takes)), tool);
  if (!isRow(priced.material)) throw new Error(`${tool} gave no material.`);
  return priced.material;
}

/**
 * checkout.start-checkout: a paid choice becomes a Stripe hosted checkout the buyer is redirected to; a choice that
 * asks for nothing today and nothing later completes here with no provider.
 */
export async function startAnswer(payload: unknown, run: RunTool, context: CheckoutContext): Promise<Row> {
  const material = await prepareAnswer(payload, run);
  if (zero(material.amountDueTodayCents) && zero(material.recurringAmountCents)) return { ...material, status: 'completed' };
  const start = targets.start;
  const here = `${context.origin}${context.path}`;
  const query = new URLSearchParams(start.return_query as Record<string, string>).toString().replace(/%7B/g, '{').replace(/%7D/g, '}');
  const session = resultOf(await run(start.tool, {
    ...pick(payload, start.takes),
    seller_connection: context.sellerConnection,
    success_url: `${here}?${query}`,
    cancel_url: here,
  }), start.tool);
  if (typeof session.redirectUrl !== 'string' || typeof session.providerSessionId !== 'string') throw new Error(`${start.tool} gave no checkout to open.`);
  const route = isRow(payload) && typeof payload.offerId === 'string' ? await context.routeOf?.(payload.offerId) : undefined;
  if (route) context.store?.setItem(routeKey(session.providerSessionId), route);
  return { ...material, redirectUrl: session.redirectUrl, providerSessionId: session.providerSessionId };
}

/** checkout.complete-hosted-session: whether Stripe says the buyer's checkout was paid, and where to send them next. */
export async function completeAnswer(payload: unknown, run: RunTool, context: CheckoutContext): Promise<Row> {
  const sessionId = isRow(payload) && typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sessionId) throw new Error('A checkout needs its session id.');
  const complete = targets.complete;
  const seen = resultOf(await run(complete.tool, { provider_session_id: sessionId, seller_connection: context.sellerConnection }), complete.tool);
  if (seen.payment_status !== complete.paid_status) return { completed: false, status: String(seen.payment_status ?? 'open') };
  const route = context.store?.getItem(routeKey(sessionId)) ?? '';
  return { completed: true, granted: false, grantedCount: 0, status: 'completed', paymentRecorded: !route, ...(route ? { postPurchaseRoutePath: route } : {}) };
}

/** The access refs the buyer holds now, for the offers a held ref hides or shows; none when no buyer is named. */
export async function heldRefsAnswer(run: RunTool, context: CheckoutContext): Promise<string[]> {
  if (!context.subject) return [];
  const { tool } = targets.held;
  const held = resultOf(await run(tool, { subject: context.subject }), tool);
  return Array.isArray(held.held_access_refs) ? held.held_access_refs.filter((ref): ref is string => typeof ref === 'string') : [];
}
