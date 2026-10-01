// packages/unit-economics/read-data/compute-unit-economics.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pure unit-economics computation: from one period's revenue, cost, spend
// and customer counts, derive ARPU, gross margin, CAC, LTV, LTV:CAC and payback.
// These formulas are Physics — they hold for any subscription/transaction
// business — so this module names nothing business-specific, imports nothing,
// and couples to nothing. The composition seam supplies the inputs (e.g. from
// revenue-ledger output + ad spend + customer counts).
//
// HONESTY (L117): every ratio is `number | null`. Null means "not derivable
// from these inputs" (missing data or a zero denominator) — never a fabricated
// number. A finance surface that shows null as "—" tells the truth; a 0 would
// lie ("CAC is zero") when the truth is "spend is unknown".
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { UnitEconomics, UnitEconomicsInput } from "./unit-economics-types.ts";

/**
 * Compute unit economics for one period. Pure + total: any input yields a
 * well-formed `UnitEconomics`, with null for every figure not derivable from the
 * supplied data. Integer-cents outputs are rounded to whole cents.
 */
export function computeUnitEconomics(input: UnitEconomicsInput): UnitEconomics {
  const arpu_cents = ratioCents(input.net_revenue_cents, input.active_customers);

  const gross_margin = grossMargin(input.gross_revenue_cents, input.cost_of_delivery_cents);

  const cac_cents = ratioCents(input.acquisition_spend_cents, input.new_customers);

  const lifetime_periods = resolveLifetime(input.avg_lifetime_periods, input.churn_rate);

  // Per-period contribution per customer = ARPU * gross margin. When margin is
  // unknown we cannot honestly fold it in, so contribution (and thus LTV /
  // payback) stays null rather than silently assuming 100% margin.
  const contribution_cents = multiply(arpu_cents, gross_margin);

  const ltv_cents = roundCents(multiply(contribution_cents, lifetime_periods));

  const ltv_to_cac = divide(ltv_cents, cac_cents);

  const payback_periods = divide(cac_cents, contribution_cents);

  return {
    arpu_cents,
    gross_margin,
    cac_cents,
    ltv_cents,
    ltv_to_cac,
    payback_periods,
    lifetime_periods,
  };
}

/** Integer-cents ratio (numerator cents / count), rounded. Null when the count
 *  is missing or zero, or the numerator is missing. */
function ratioCents(numeratorCents: number | undefined, count: number | undefined): number | null {
  if (numeratorCents === undefined || count === undefined || count === 0) return null;
  return Math.round(numeratorCents / count);
}

/** Gross margin in (-inf, 1]. Null when gross is missing/zero or cost missing. */
function grossMargin(grossCents: number, costCents: number | undefined): number | null {
  if (costCents === undefined || grossCents === 0) return null;
  return (grossCents - costCents) / grossCents;
}

/** Resolve lifetime in periods: explicit value wins; else 1/churn for churn in
 *  (0,1]; else null. */
function resolveLifetime(avgLifetime: number | undefined, churn: number | undefined): number | null {
  if (avgLifetime !== undefined && avgLifetime > 0) return avgLifetime;
  if (churn !== undefined && churn > 0 && churn <= 1) return 1 / churn;
  return null;
}

/** Multiply two maybe-null factors; null if either is null. */
function multiply(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a * b;
}

/** Divide two maybe-null values; null if either is null or the divisor is 0. */
function divide(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/** Round a maybe-null cents value to whole cents. */
function roundCents(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
