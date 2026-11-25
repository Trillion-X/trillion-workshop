// tools/welcome-a-buyer-back-after-checkout/show/checkout-state.ts
//
// PURPOSE
//   What the welcome page says of a buyer's checkout, decided from the answer of tool:look-up-a-stripe-checkout ({ payment_status,
//   status }: the checkout's own words) and from the address the buyer came back with. Pure: no fetch, no window.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `paid` only when the checkout is complete and paid (or needs no payment); any other answer is `waiting`.
//   2. A read that failed is `none`, and an address that is not shaped as a Stripe checkout id is never asked about.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

// A Stripe checkout id as a buyer's address carries it; any other text names no checkout, and no call is made for it.
export const CHECKOUT_ID = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;

// The state a checkout's answer comes to. `answer` is the parsed body of a 200 read; null is a read that failed.
export function checkoutState(answer: { status?: unknown; payment_status?: unknown } | null): 'paid' | 'waiting' | 'none' {
  if (answer === null || typeof answer !== 'object') return 'none';
  return answer.status === 'complete' && (answer.payment_status === 'paid' || answer.payment_status === 'no_payment_required') ? 'paid' : 'waiting';
}
