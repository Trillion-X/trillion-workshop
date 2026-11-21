// tools/take-payments/packages/billing/show/billing-screen-view.ts
//
// PURPOSE
//   Which of the four views the billing screen draws, decided from what the host said and what the read did. Kept
//   apart from the screen's JSX so the views are told apart by a test that needs no browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A person with no purchase is on the free plan: the screen reads nothing and draws the plans, never a read error.
//   2. A read error is only a read error: it comes from a read that was made and failed.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type BillingScreenView = 'free' | 'read-error' | 'loading' | 'purchase';

export function billingScreenView({ hasPurchase, loaded, failed }: { hasPurchase: boolean; loaded: boolean; failed: boolean }): BillingScreenView {
  if (!hasPurchase) return 'free';
  if (failed) return 'read-error';
  if (!loaded) return 'loading';
  return 'purchase';
}
