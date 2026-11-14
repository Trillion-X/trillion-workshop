// tools/take-payments/read-data/checkout-contract.ts
//
// What a sale is asked in, as the quote reads it: who is buying, what they agreed to, and which offer and price they
// chose. Everything the buyer sends is a request, never a price: `buildCheckoutMaterialQuote` works the amount out
// from the seller's offer rows, so an amount typed by the buyer is only ever a contribution inside a range the seller
// published.

export type CheckoutCustomer = {
  country?: string;
  email: string;
  firstName: string;
  lastName: string;
  postalCode?: string;
};

export type CheckoutConsent = {
  billing: boolean;
  legal: boolean;
};

export type CheckoutMaterialRequest = {
  checkoutAttemptId: string;
  checkoutCode?: string;
  checkoutStartedAt: string;
  // The origin the buyer returns to after the payment provider's hosted page. A return address is a property of the
  // session, so the page that started the attempt names its own origin. A free checkout never leaves the page.
  returnUrlBase?: string;
  offerId: string;
  priceOptionId: string;
  customerSelectedAmountCents?: number;
  /** N-dimensional quantities the offer's charge dimensions ask for; ignored only when absent. */
  chargeDimensions?: Array<{
    dimensionId: string;
    units?: number;
    scopedUnits?: Array<{ scopeId: string; units: number }>;
  }>;
  // Chosen billable unit quantity (for example a seat count). Absent or invalid means the price option's
  // included_units baseline. The quote clamps this to the option's own included units; it is never trusted raw.
  unitCount?: number;
};

export type CheckoutStartPayload = CheckoutMaterialRequest & {
  consent: CheckoutConsent;
  /**
   * OPTIONAL identity before the provider's page. The provider collects the buyer's real email and name on its own
   * page, so a direct pay-button click may start a session with no customer fields. When present they are validated.
   * Never invent values here.
   */
  customer?: CheckoutCustomer;
};

// What the buyer checkout screen reads back (packages/checkout/show), restored from the old checkout package's contract
// (bitfield-packages d926b7adb, packages/checkout/read-data/checkout-contract.ts) word for word. The gate receipt is the old
// engine's signed quote; the Workshop's answers (web/src/workspace/checkout-answers.ts) carry none, so a start answer leaves it out.

export type CheckoutChargeDimensionBreakdownResponse = {
  amountCents: string;
  dimensionId: string;
  inputKind: 'scalar' | 'per_scope';
  units?: number;
  scopedUnits?: Array<{ amountCents: string; scopeId: string; units: number }>;
};

export type CheckoutGateReceipt = {
  checkoutAttemptId: string;
  accountId: string;
  policyHash: string;
  quoteReservationId: string;
  quoteSignature: string;
};

export type PaymentProviderPublicMaterial = {
  publicKey: string;
  // Stripe payment_method_configuration id (pmc_…) from the provider descriptor
  // DATA record; scopes which payment methods the Payment Element offers.
  paymentMethodConfiguration?: string;
};

export type CheckoutAppliedAdjustmentResponse = {
  code: string;
  discountCents: string;
  id: string;
  label: string;
  resultLabel: string;
};

export type CheckoutMaterialResponse = {
  appliedAdjustment?: CheckoutAppliedAdjustmentResponse;
  /** Soft, non-fatal notice when an entered code was invalid/inapplicable/zero-effect. The form still loads at full price. */
  codeNotice?: string;
  accessRefs: string[];
  amountDueTodayCents: string;
  billingMode: string;
  canonicalPlanId: string;
  chargeDimensions?: CheckoutChargeDimensionBreakdownResponse[];
  currency: string;
  offerId: string;
  paymentMaterialTarget?: string;
  paymentMode: string;
  priceOptionId: string;
  provider_ref?: string;
  providerMaterial?: PaymentProviderPublicMaterial;
  /**
   * Hosted-provider redirect URL (e.g. Stripe hosted Checkout Session). When
   * present, the paid flow redirects the browser here instead of mounting an
   * inline payment slot — the provider hosts card entry and grants via webhook.
   */
  redirectUrl?: string;
  /** Provider session id backing `redirectUrl` (echoed for read/reconcile). */
  providerSessionId?: string;
  recurringAmountCents: string;
  trialDays: number;
  unitCount: number;
};

export type CheckoutStartResponse = CheckoutMaterialResponse & {
  customerId?: string;
  gate: CheckoutGateReceipt;
  providerSessionId?: string;
  status?: string;
  subscriptionId?: string;
};
