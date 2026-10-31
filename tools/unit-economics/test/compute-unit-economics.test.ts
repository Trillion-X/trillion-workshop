// tools/unit-economics/test/compute-unit-economics.test.ts
//
// Proves the unit-economics formulas + the honesty invariant: unknown inputs
// yield null, never a fabricated number (L117). Pure + deterministic.

import { describe, it, expect } from "../../../test-helpers/vitest-shim.mjs";
import { computeUnitEconomics } from "../read-data/compute-unit-economics.ts";

describe("computeUnitEconomics — full inputs", () => {
  it("derives ARPU, margin, CAC, LTV, ratio, payback from a complete period", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 100_000, // $1,000 net across customers
      gross_revenue_cents: 120_000,
      cost_of_delivery_cents: 30_000, // margin = (120k-30k)/120k = 0.75
      acquisition_spend_cents: 40_000,
      active_customers: 100, // ARPU = 1000c = $10.00
      new_customers: 20, // CAC = 40000/20 = 2000c = $20.00
      avg_lifetime_periods: 12,
    });
    expect(e.arpu_cents).toBe(1_000);
    expect(e.gross_margin).toBeCloseTo(0.75, 10);
    expect(e.cac_cents).toBe(2_000);
    expect(e.lifetime_periods).toBe(12);
    // LTV = ARPU(1000) * margin(0.75) * lifetime(12) = 9000c
    expect(e.ltv_cents).toBe(9_000);
    // LTV:CAC = 9000 / 2000 = 4.5
    expect(e.ltv_to_cac).toBeCloseTo(4.5, 10);
    // payback = CAC(2000) / contribution(1000*0.75=750) = 2.666..
    expect(e.payback_periods).toBeCloseTo(2_000 / 750, 10);
  });

  it("resolves lifetime from churn when avg_lifetime is absent (1/churn)", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 50_000,
      gross_revenue_cents: 50_000,
      cost_of_delivery_cents: 10_000,
      active_customers: 50,
      churn_rate: 0.05, // lifetime = 20 periods
    });
    expect(e.lifetime_periods).toBe(20);
  });

  it("explicit avg_lifetime wins over churn", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 50_000,
      gross_revenue_cents: 50_000,
      active_customers: 50,
      avg_lifetime_periods: 8,
      churn_rate: 0.05,
    });
    expect(e.lifetime_periods).toBe(8);
  });
});

describe("computeUnitEconomics — honesty: unknown -> null, never fabricated (L117)", () => {
  it("no spend/new customers -> CAC, LTV:CAC, payback are null (not 0)", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 100_000,
      gross_revenue_cents: 120_000,
      cost_of_delivery_cents: 30_000,
      active_customers: 100,
      avg_lifetime_periods: 12,
    });
    expect(e.cac_cents).toBeNull();
    expect(e.ltv_to_cac).toBeNull();
    expect(e.payback_periods).toBeNull();
    // but the figures that ARE derivable still compute
    expect(e.arpu_cents).toBe(1_000);
    expect(e.ltv_cents).toBe(9_000);
  });

  it("no cost -> gross margin null -> LTV and payback null (no assumed 100% margin)", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 100_000,
      gross_revenue_cents: 120_000,
      acquisition_spend_cents: 40_000,
      active_customers: 100,
      new_customers: 20,
      avg_lifetime_periods: 12,
    });
    expect(e.gross_margin).toBeNull();
    expect(e.ltv_cents).toBeNull();
    expect(e.payback_periods).toBeNull();
    expect(e.cac_cents).toBe(2_000); // CAC still derivable
  });

  it("zero customers -> ARPU null (no divide-by-zero, no fake 0)", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 0,
      gross_revenue_cents: 0,
      active_customers: 0,
    });
    expect(e.arpu_cents).toBeNull();
    expect(e.gross_margin).toBeNull();
    expect(e.ltv_cents).toBeNull();
  });

  it("no lifetime signal -> lifetime, LTV null", () => {
    const e = computeUnitEconomics({
      net_revenue_cents: 100_000,
      gross_revenue_cents: 120_000,
      cost_of_delivery_cents: 30_000,
      active_customers: 100,
      new_customers: 20,
      acquisition_spend_cents: 40_000,
    });
    expect(e.lifetime_periods).toBeNull();
    expect(e.ltv_cents).toBeNull(); // LTV needs lifetime
    // payback does NOT need lifetime: CAC(2000) / contribution(1000*0.75=750)
    expect(e.payback_periods).toBeCloseTo(2_000 / 750, 10);
    expect(e.cac_cents).toBe(2_000);
    expect(e.arpu_cents).toBe(1_000);
  });
});

describe("computeUnitEconomics — purity", () => {
  it("same input -> identical output", () => {
    const input = {
      net_revenue_cents: 100_000,
      gross_revenue_cents: 120_000,
      cost_of_delivery_cents: 30_000,
      acquisition_spend_cents: 40_000,
      active_customers: 100,
      new_customers: 20,
      avg_lifetime_periods: 12,
    } as const;
    expect(computeUnitEconomics(input)).toEqual(computeUnitEconomics(input));
  });
});
