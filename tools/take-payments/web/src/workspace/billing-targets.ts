// tools/take-payments/web/src/workspace/billing-targets.ts
//
// PURPOSE
//   Answers the billing screen's two needs from the Workshop tools billing-targets.json names: the page of one purchase
//   (plan, renewal, card, receipts) and the Stripe billing-page step a button opens. Each answer is one tool run through
//   the page's one run owner (runWorkshopTool), with the seller's account the screen's connection means (seller-account.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every answer is a tool run; nothing here reaches Stripe or holds a key.
//   2. The return address is the page the buyer is on, so Stripe's page brings them back to it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { newRunKey, runWorkshopTool } from '#workspace/workshop-tool-api';
import type { BillingFlow, BillingPage } from '../../../packages/billing/show/BillingScreen';
import targets from './billing-targets.json' with { type: 'json' };
import { sellerAccountOf } from './seller-account';
import { readHeldNames } from './seller-account-names';

const run = (tool: string, input: Record<string, unknown>) => runWorkshopTool(tool, input, newRunKey('billing')) as Promise<{ result?: unknown }>;

/** The seller's account the screen's connection means (seller-account.ts), the one the screen names or the targets' own. */
const sellerOf = (sellerConnection?: string) => sellerAccountOf(sellerConnection || targets.seller_connection, run, readHeldNames);

/** The page of one purchase, as the buyer sees it; the purchase must be the signed-in buyer's. */
export async function readBillingPage(subscriptionId: string, subjectEmail: string, sellerConnection?: string): Promise<BillingPage> {
  const { result } = await run(targets.page.tool, { seller_connection: await sellerOf(sellerConnection), subscription_id: subscriptionId, subject_email: subjectEmail });
  return result as BillingPage;
}

/** The address of the Stripe billing-page step for one flow; the caller goes there. */
export async function openBillingFlow(subscriptionId: string, subjectEmail: string, flow: BillingFlow, sellerConnection?: string): Promise<{ redirect: string }> {
  const { result } = await run(targets.open.tool, {
    seller_connection: await sellerOf(sellerConnection),
    subscription_id: subscriptionId,
    subject_email: subjectEmail,
    return_url: window.location.href,
    flow,
  });
  return result as { redirect: string };
}
