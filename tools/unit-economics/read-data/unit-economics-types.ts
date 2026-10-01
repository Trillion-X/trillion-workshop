// packages/unit-economics/read-data/unit-economics-types.ts
//
// Purpose: Canonical types for the generic unit-economics computation.
// Generic Physics — the formulas (ARPU, gross margin, CAC, LTV, payback) hold
// for ANY subscription/transaction business. No business-specific names, no
// closed enums. The inputs are plain integers/ratios supplied at the
// composition seam (e.g. from revenue-ledger output + spend + customer counts),
// so this package imports nothing and couples to nothing.
//
// Non-Negotiable Invariants:
//   Every output ratio is `number | null`. A ratio is null exactly when its
//   inputs are absent or its denominator is zero — NEVER a fabricated 0 or
//   placeholder (L117). "Unknown" and "zero" are different truths.
//   Amounts are integer cents; periods are unitless counts (the caller decides
//   whether a period is a month, week, or cohort window).

/** Inputs for one period of unit-economics, all from the composition seam.
 *  Cost/spend/new-customer/lifetime inputs are not always known — absence is a
 *  legitimate state that yields null outputs, not an error. */
export type UnitEconomicsInput = {
  /** Net revenue in the period (integer cents). */
  net_revenue_cents: number;
  /** Gross revenue in the period (integer cents) — basis for gross margin. */
  gross_revenue_cents: number;
  /** Cost of delivering the product/service this period (integer cents). */
  cost_of_delivery_cents?: number;
  /** Acquisition/marketing spend this period (integer cents). */
  acquisition_spend_cents?: number;
  /** Customers active during the period (revenue-bearing). */
  active_customers: number;
  /** Newly acquired customers this period (denominator for CAC). */
  new_customers?: number;
  /** Average customer lifetime in periods, if known directly. */
  avg_lifetime_periods?: number;
  /** Per-period churn rate in [0,1]; lifetime = 1/churn when > 0. Used only
   *  when `avg_lifetime_periods` is not supplied. */
  churn_rate?: number;
};

/** The computed unit economics. Each field is null when not derivable from the
 *  given inputs (honest unknown, never a fake number). */
export type UnitEconomics = {
  /** Average revenue per active customer (net) — integer cents. */
  arpu_cents: number | null;
  /** Gross margin in [.., 1] = (gross - cost) / gross. */
  gross_margin: number | null;
  /** Customer acquisition cost — integer cents = spend / new customers. */
  cac_cents: number | null;
  /** Lifetime value — integer cents = ARPU * gross margin * lifetime periods. */
  ltv_cents: number | null;
  /** LTV : CAC ratio (the health number; > 3 is the classic target). */
  ltv_to_cac: number | null;
  /** Periods to recoup CAC from per-period contribution margin. */
  payback_periods: number | null;
  /** Resolved customer lifetime in periods (from input or 1/churn). */
  lifetime_periods: number | null;
};
