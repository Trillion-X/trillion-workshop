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
