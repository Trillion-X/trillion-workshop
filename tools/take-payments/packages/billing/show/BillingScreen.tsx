'use client';

// tools/take-payments/packages/billing/show/BillingScreen.tsx
//
// PURPOSE
//   The billing screen of one signed-in person, drawn by the shared guide (tools/ui/show/coss/guide.tsx) from the
//   description read-data/billing-guide.ts builds: their plan, its card, its receipts, the other plans with a Join, and
//   cancelling. This file reads the purchase (when there is one) and answers the guide's actions: a billing step opens
//   Stripe's billing page on that step (`openFlow`), and a Join starts the checkout the host answers (`startCheckout`) and
//   goes to Stripe's checkout page. The buyer confirms every change on Stripe's page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file reads and changes nothing itself: the page comes from `readPage`, each step from `openFlow`, each checkout
//      from `startCheckout`, all given by the screen's mount. The plan and the other plans come from the host.
//   2. Every word and part is the guide description's (billing-guide.ts, billing-guide-words.json); no markup or style here.
//   3. A read that is still going or failed is drawn by the shared screen-state part; a person with no purchase reads
//      nothing and sees their plan and the plans to join.
//   4. A checkout goes only to Stripe's checkout page (https://checkout.stripe.com/); any other answer is refused.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { ErrorBoundary } from '../../../../ui';
import { ScreenState } from '../../../../ui/show/screen-state';
import { Guide, type GuideAction } from '../../../../ui/show/coss/guide';
import { BILLING_FLOW, JOIN_PLAN, billingGuide, billingWords as words, type BillingFlow, type BillingPage, type HeldPlan, type OtherPlan } from '../read-data/billing-guide';

/** One checkout start for one plan; answers the address of Stripe's checkout page. */
export type StartCheckout = (plan: { offer_id: string; price_option_id: string; selected_amount_cents?: number }) => Promise<{ redirectUrl: string }>;

export interface BillingScreenProps {
  /** False when the person holds no purchase: the screen reads nothing and shows the free plan with the plans to join. */
  hasPurchase: boolean;
  plan: HeldPlan;
  otherPlans: OtherPlan[];
  readPage: () => Promise<BillingPage>;
  openFlow: (flow: BillingFlow) => Promise<{ redirect: string }>;
  /** Null when the host gave no checkout: the plans are shown without a Join. */
  startCheckout: StartCheckout | null;
}

const STRIPE_CHECKOUT = /^https:\/\/checkout\.stripe\.com\//;

export function BillingScreen({ hasPurchase, plan, otherPlans, readPage, openFlow, startCheckout }: BillingScreenProps) {
  const [page, setPage] = React.useState<BillingPage | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!hasPurchase) return undefined;
    let cancelled = false;
    setFailed(false);
    readPage().then(found => { if (!cancelled) setPage(found); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [hasPurchase, readPage, attempt]);

  const description = React.useMemo(
    () => (hasPurchase && !page ? null : billingGuide({ plan, otherPlans, page: hasPurchase ? page : null, canJoin: startCheckout !== null })),
    [hasPurchase, page, plan, otherPlans, startCheckout],
  );

  // Each action is one press: the button waits on Stripe's address, then the browser goes there. A refusal leaves the
  // button in its failed state (the shared Button draws it) and the person on this screen.
  const onAction = React.useCallback(async (action: GuideAction) => {
    const body = action.send?.body ?? {};
    if (action.send?.path === BILLING_FLOW) {
      const { redirect } = await openFlow(body.flow as BillingFlow);
      window.location.assign(redirect);
    } else if (action.send?.path === JOIN_PLAN && startCheckout) {
      const { redirectUrl } = await startCheckout({ offer_id: String(body.offer_id), price_option_id: String(body.price_option_id), ...(typeof body.selected_amount_cents === 'number' ? { selected_amount_cents: body.selected_amount_cents } : {}) });
      if (!STRIPE_CHECKOUT.test(redirectUrl ?? '')) throw new Error(words.join_failed);
      window.location.assign(redirectUrl);
    }
  }, [openFlow, startCheckout]);

  if (hasPurchase && failed) return <ScreenState state={{ status: 'failed', title: words.read_error, retry: { label: words.try_again, run: () => setAttempt(count => count + 1) } }} />;
  if (!description) return <ScreenState state={{ status: 'loading', label: words.loading }} />;
  return (
    <ErrorBoundary zoneName="billing">
      <Guide description={description} onAction={onAction} />
    </ErrorBoundary>
  );
}
