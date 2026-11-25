// tools/take-payments/web/src/workspace/billing-screen-mount.tsx
//
// PURPOSE
//   The billing screen's module entry (tool:show-one-purchase-plan-card-and-receipts's screen): the one file the screen's
//   row names (`screen.module.entry`), whose single export, `mount(element, props)`, is the contract of the module kind
//   (web/src/workspace/tool-screen.tsx). It takes the purchase the screen names (`subscription_id`, the sub_ id of one
//   purchase), the seller connection, the plans the host answers and the host's checkout address, and mounts BillingScreen
//   with the page and step answered by billing-targets.ts and the checkout answered by the host.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { mountReactSurface } from '../../../../ui';
import { BillingScreen, type StartCheckout } from '../../../packages/billing/show/BillingScreen';
import type { HeldPlan, OtherPlan } from '../../../packages/billing/read-data/billing-guide';
import { openBillingFlow, readBillingPage } from './billing-targets';

type BillingScreenInput = {
  subscription_id?: string;
  subject_email?: string;
  seller_connection?: string;
  plan?: HeldPlan;
  other_plans?: OtherPlan[];
  /** The host's own checkout address (POST, the program page's checkout request; answers { redirectUrl }). */
  checkout_address?: string;
  [key: string]: unknown;
};

/** A checkout through the host's own address, with the request the program page's price card sends: the buyer agrees to
 *  the billing and legal terms by pressing Join, and Stripe's page collects everything else. */
function checkoutThrough(address: string): StartCheckout {
  return async ({ offer_id: offerId, price_option_id: priceOptionId, selected_amount_cents: selectedAmountCents }) => {
    const answer = await fetch(address, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        checkoutAttemptId: crypto.randomUUID(),
        checkoutStartedAt: new Date().toISOString(),
        consent: { billing: true, legal: true },
        ...(selectedAmountCents === undefined ? {} : { customerSelectedAmountCents: selectedAmountCents }),
        offerId,
        priceOptionId,
        returnUrlBase: window.location.origin,
      }),
    });
    const result = (await answer.json().catch(() => ({}))) as { redirectUrl?: string; error?: string };
    if (!answer.ok || !result.redirectUrl) throw new Error(result.error ?? `The checkout answered ${answer.status}.`);
    return { redirectUrl: result.redirectUrl };
  };
}

// subject_email is the signed-in buyer's verified email, given by the host that mounts the screen; the purchase must be theirs.
// plan and other_plans are the host's own answer (the member's offers and held access), so a person with no purchase still sees their plan.
// A host row that leaves either out (a billing row whose host_input omits them) draws a free plan with no other plans, not a blank screen.
const NO_PLAN: HeldPlan = { id: 'none', label: null, paid: false, price_text: null };

export function mount(element: HTMLElement, props: BillingScreenInput) {
  const { subscription_id: subscriptionId = '', subject_email: subjectEmail = '', seller_connection: sellerConnection, plan = NO_PLAN, other_plans: otherPlans = [], checkout_address: checkoutAddress } = props;
  return mountReactSurface(element, (
    <BillingScreen
      hasPurchase={subscriptionId !== ''}
      plan={plan}
      otherPlans={otherPlans}
      readPage={() => readBillingPage(subscriptionId, subjectEmail, sellerConnection)}
      openFlow={flow => openBillingFlow(subscriptionId, subjectEmail, flow, sellerConnection)}
      startCheckout={checkoutAddress ? checkoutThrough(checkoutAddress) : null}
    />
  ));
}
