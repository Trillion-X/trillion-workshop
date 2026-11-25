// tools/take-payments/packages/billing/read-data/billing-guide.ts
//
// PURPOSE
//   The billing screen of one signed-in person as one guide description (tools/ui/show/coss/guide.tsx draws it): the plan
//   they are on with its price, status and renewal or end date; the card that pays it; its receipts; the other plans, each
//   with a Join; and cancelling. This is the first platform repository's Billing and Plan screens' shape (src/billing-screen.mjs,
//   src/account-screens.mjs planOffers): a builder that turns what was read into words and rows, and the shared guide that
//   draws them. Every word is in billing-guide-words.json.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: what was read in, a description out. Nothing here reads, sends, or knows an address. What an action does is
//      the screen's (BillingScreen.tsx): an action names its kind in `send.path` (BILLING_FLOW or JOIN_PLAN) and its
//      values in `send.body`.
//   2. No key, card number or fingerprint is ever shown; the card is brand, last four and expiry only.
//   3. A part with nothing to show is not drawn: a free person gets no card, receipts or cancel part, and a plan with no
//      price option to buy has no Join.
//   4. Each change of a paid plan (card, plan, cancel) is one press that opens the matching step of Stripe's billing page,
//      where the person confirms it, so cancelling takes no more presses than joining.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { GuideDescription, GuideRow, GuideSection } from '../../../../ui/show/coss/guide.tsx';
import { formatMoneyCents } from '../../../../ui/show/format-money.ts';
import words from './billing-guide-words.json' with { type: 'json' };

export type BillingFlow = 'payment_method_update' | 'subscription_update' | 'subscription_cancel';

/** The plan the person is on now: a paid plan's offer (its label and price), a subscription the offers do not describe
 *  (label null: the provider's read names it), or the free plan (paid false). */
export interface HeldPlan {
  id: string;
  label: string | null;
  paid: boolean;
  price_text: string | null;
}

/** A plan the person could move to, with its price, the price option a Join buys (none: the plan shows no Join), and, for a
 *  price the buyer may choose, the amount a Join pays (its listed price). */
export interface OtherPlan {
  id: string;
  label: string;
  price_text: string;
  price_option_id?: string;
  selected_amount_cents?: number;
}

export interface BillingPlan {
  label: string | null;
  amount_cents: number | null;
  currency: string | null;
  interval: string | null;
  quantity: number;
}

export interface BillingCard {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

export interface BillingReceipt {
  id: string;
  number: string | null;
  created_at: string | null;
  status: string | null;
  amount_paid_cents: number | null;
  currency: string | null;
  receipt_url: string | null;
}

export interface BillingPage {
  subscription_id: string;
  status: string | null;
  cancel_at_period_end: boolean;
  renews_at: string | null;
  ends_at: string | null;
  plan: BillingPlan | null;
  card: BillingCard | null;
  receipts: BillingReceipt[];
}

/** The `send.path` of an action that opens one step of Stripe's billing page; its body is { flow }. */
export const BILLING_FLOW = 'billing-flow';
/** The `send.path` of an action that starts a checkout for one plan; its body is { offer_id, price_option_id } and, for a
 *  price the buyer may choose, selected_amount_cents. */
export const JOIN_PLAN = 'join-plan';

export type BillingGuideInput = {
  plan: HeldPlan;
  otherPlans: OtherPlan[];
  /** The purchase as the provider read it; null for a person with no purchase. */
  page: BillingPage | null;
  /** False when the host gave no checkout address: the plans are shown without a Join. */
  canJoin: boolean;
};

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
const money = (cents: number | null, currency: string | null) => (cents === null ? null : formatMoneyCents(cents, currency ?? 'usd'));
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const flow = (label: string, which: BillingFlow, tone: string) => ({ label, tone, busy_label: words.opening, send: { path: BILLING_FLOW, body: { flow: which } } });

/** The price of the plan the person holds: the provider's read when it names one, else the offer's own price words. */
function priceOf(page: BillingPage | null, plan: HeldPlan): string | null {
  const read = page?.plan;
  const amount = read ? money(read.amount_cents, read.currency) : null;
  if (amount) return read?.interval ? fill(words.per_interval, { amount, interval: read.interval }) : amount;
  return plan.price_text;
}

/** The plan's status badge: what the provider says about the purchase, in plain words and a tone. */
function statusOf(page: BillingPage): { label: string; tone: string } {
  if (page.cancel_at_period_end) return { label: fill(words.status_ends, { date: day(page.ends_at ?? page.renews_at) ?? '' }).trim(), tone: 'attention' };
  if (page.status === 'active') return { label: words.status_active, tone: 'good' };
  if (page.status === 'trialing') return { label: words.status_trial, tone: 'info' };
  if (page.status === 'past_due' || page.status === 'unpaid' || page.status === 'incomplete') return { label: words.status_past_due, tone: 'bad' };
  return { label: words.status_other, tone: 'quiet' };
}

function planSection({ plan, page }: BillingGuideInput): GuideSection {
  // No purchase of their own: the free plan, or a plan whose access they hold without paying for it here (given, or paid by
  // someone else), which has nothing to manage.
  if (!page) {
    const row: GuideRow = plan.paid
      ? { id: 'plan', title: plan.label ?? words.your_plan, detail: words.included_detail, status: { label: words.status_active, tone: 'good' } }
      : { id: 'plan', title: plan.label ?? words.free_plan, detail: words.free_detail, status: { label: words.status_free, tone: 'quiet' } };
    return { id: 'plan', heading: words.plan_heading, rows: [row] };
  }
  const price = priceOf(page, plan);
  const ending = page.cancel_at_period_end;
  const date = day(ending ? page.ends_at ?? page.renews_at : page.renews_at);
  const detail = price && date ? fill(ending ? words.plan_ends : words.plan_renews, { price, date }) : price ? fill(words.plan_price_only, { price }) : undefined;
  return {
    id: 'plan', heading: words.plan_heading,
    rows: [{ id: 'plan', title: page.plan?.label ?? plan.label ?? words.your_plan, detail, status: statusOf(page), actions: [flow(words.change_plan, 'subscription_update', 'quiet')] }],
  };
}

function cardSection(page: BillingPage): GuideSection {
  const card = page.card;
  const row: GuideRow = card
    ? { id: 'card', title: fill(words.card, { brand: capitalised(card.brand), last4: card.last4 }), detail: fill(words.card_expires, { month: String(card.exp_month).padStart(2, '0'), year: String(card.exp_year).slice(-2) }), actions: [flow(words.update_card, 'payment_method_update', 'quiet')] }
    : { id: 'card', title: words.no_card, detail: words.no_card_detail, status: { label: words.no_card, tone: 'attention' }, actions: [flow(words.update_card, 'payment_method_update', 'primary')] };
  return { id: 'card', heading: words.card_heading, body: words.card_body, rows: [row] };
}

function receiptsSection(page: BillingPage): GuideSection | null {
  if (!page.receipts.length) return null;
  return {
    id: 'receipts', heading: words.receipts_heading,
    rows: page.receipts.map(receipt => {
      const amount = money(receipt.amount_paid_cents, receipt.currency) ?? '';
      const paid = receipt.status === 'paid';
      return {
        id: `receipt:${receipt.id}`,
        title: day(receipt.created_at) ?? amount,
        detail: receipt.number ? fill(words.receipt_number, { amount, number: receipt.number }) : amount,
        status: { label: paid ? words.receipt_paid : words.receipt_open, tone: paid ? 'good' : 'attention' },
        ...(receipt.receipt_url ? { actions: [{ label: words.view_receipt, tone: 'quiet', href: receipt.receipt_url }] } : {}),
      };
    }),
  };
}

function plansSection({ plan, otherPlans, page, canJoin }: BillingGuideInput): GuideSection | null {
  if (!otherPlans.length) return null;
  return {
    id: 'plans', heading: page || plan.paid ? words.plans_heading : words.plans_heading_free, body: canJoin ? words.plans_body : undefined,
    rows: otherPlans.map(other => ({
      id: `plan:${other.id}`, title: other.label, detail: other.price_text,
      ...(canJoin && other.price_option_id ? { actions: [{ label: words.join, tone: 'primary', busy_label: words.joining, send: { path: JOIN_PLAN, body: { offer_id: other.id, price_option_id: other.price_option_id, ...(other.selected_amount_cents === undefined ? {} : { selected_amount_cents: other.selected_amount_cents }) } } }] } : {}),
    })),
  };
}

function cancelSection(page: BillingPage): GuideSection | null {
  if (page.cancel_at_period_end) return null;
  const date = day(page.renews_at);
  return { id: 'cancel', heading: words.cancel_heading, body: date ? fill(words.cancel_body, { date }) : words.cancel_body_no_date, actions: [flow(words.cancel, 'subscription_cancel', 'danger')] };
}

/** The billing screen's description: plan, card, receipts, other plans and cancel, for a paid purchase; plan and plans to
 *  join for a person with none. */
export function billingGuide(input: BillingGuideInput): GuideDescription {
  const { page } = input;
  const sections = page
    ? [planSection(input), cardSection(page), receiptsSection(page), plansSection(input), cancelSection(page)]
    : [planSection(input), plansSection(input)];
  const lead = page ? words.lead_paid : input.plan.paid ? words.lead_included : words.lead_free;
  return { title: words.title, lead, sections: sections.filter((section): section is GuideSection => section !== null) };
}

export { words as billingWords };
