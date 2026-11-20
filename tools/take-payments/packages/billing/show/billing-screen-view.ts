// tools/take-payments/packages/billing/show/billing-screen-view.ts
//
// PURPOSE
//   Which of the four views the billing screen draws, decided from what the host said and what the read did. Kept
//   apart from the screen's JSX so the two empty cases (no purchase at all, and a read that failed) are told apart by a
//   test that needs no browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No purchase is never a read error: with no purchase the screen reads nothing and says there is no plan yet.
//   2. A read error is only a read error: it comes from a read that was made and failed.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type BillingScreenView = 'no-purchase' | 'read-error' | 'loading' | 'purchase';

export function billingScreenView({ hasPurchase, loaded, failed }: { hasPurchase: boolean; loaded: boolean; failed: boolean }): BillingScreenView {
  if (!hasPurchase) return 'no-purchase';
  if (failed) return 'read-error';
  if (!loaded) return 'loading';
  return 'purchase';
}
