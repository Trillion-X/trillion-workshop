// packages/revenue-ledger/show/__tests__/present-revenue.test.ts
//
// Proves the revenue-ledger -> finance-display translation boundary across the
// render-state matrix (empty / sparse / dense) with ZERO cross-package import.
// The display model is finished, human-facing data; these tests are the visual
// proof at the data layer (a surface renders this model verbatim).

import { describe, it, expect } from "vitest";
import type { RevenueView } from "../../read-data/revenue-types";
import { presentRevenue, humanizeKey } from "../revenue-finance-display";

const EMPTY_VIEW: RevenueView = {
  gross_cents: 0,
  refunds_cents: 0,
  net_cents: 0,
  recurring_active_cents: 0,
  recurring_active_count: 0,
  by_cohort: {},
  by_event_role: {},
  review: { count: 0, items: [] },
};

describe("presentRevenue — render-state matrix", () => {
  it("empty: produces four zeroed KPI readings and no breakdown rows", () => {
    const d = presentRevenue(EMPTY_VIEW);
    expect(d.metrics.map((m) => m.id)).toEqual(["gross", "refunds", "net", "recurring"]);
    expect(d.metrics.every((m) => m.amount_cents === 0)).toBe(true);
    expect(d.metrics.every((m) => m.currency === "USD")).toBe(true);
    expect(d.cohorts).toEqual([]);
    expect(d.roles).toEqual([]);
    expect(d.currency).toBe("USD");
  });

  it("sparse: one cohort, one role — labels humanized from keys", () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      gross_cents: 2700,
      net_cents: 2700,
      by_cohort: { "federer-masterclass": { gross_cents: 2700, net_cents: 2700, count: 1 } },
      by_event_role: { add: { total_cents: 2700, count: 1 } },
    };
    const d = presentRevenue(view);
    expect(d.metrics[0]).toMatchObject({ id: "gross", label: "Gross revenue", amount_cents: 2700 });
    expect(d.cohorts).toHaveLength(1);
    expect(d.cohorts[0]).toMatchObject({
      id: "federer-masterclass",
      label: "Federer Masterclass",
      gross_cents: 2700,
      net_cents: 2700,
      count: 1,
    });
    expect(d.roles[0]).toMatchObject({ id: "add", label: "Add", gross_cents: 2700, count: 1 });
  });

  it("dense: many cohorts/roles sorted highest-gross-first, deterministic ties", () => {
    const view: RevenueView = {
      gross_cents: 13000,
      refunds_cents: 1300,
      net_cents: 11700,
      recurring_active_cents: 2700,
      recurring_active_count: 3,
      by_cohort: {
        "the-book": { gross_cents: 1300, net_cents: 1300, count: 100 },
        "federer-masterclass": { gross_cents: 8100, net_cents: 6800, count: 300 },
        "clinic-pass": { gross_cents: 3600, net_cents: 3600, count: 12 },
      },
      by_event_role: {
        add: { total_cents: 13000, count: 412 },
        subtract: { total_cents: 1300, count: 7 },
      },
      review: { count: 0, items: [] },
    };
    const d = presentRevenue(view);
    // KPI readings carry the headline numbers, recurring carries its count.
    expect(d.metrics.find((m) => m.id === "recurring")).toMatchObject({
      amount_cents: 2700,
      count: 3,
    });
    // Highest gross first: federer (8100) > clinic (3600) > book (1300).
    expect(d.cohorts.map((c) => c.id)).toEqual(["federer-masterclass", "clinic-pass", "the-book"]);
    expect(d.roles.map((r) => r.id)).toEqual(["add", "subtract"]);
  });

  it("deterministic ordering: equal gross broken by id ascending", () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      by_cohort: {
        zebra: { gross_cents: 500, net_cents: 500, count: 1 },
        alpha: { gross_cents: 500, net_cents: 500, count: 1 },
      },
    };
    const d = presentRevenue(view);
    expect(d.cohorts.map((c) => c.id)).toEqual(["alpha", "zebra"]);
  });
});

describe("presentRevenue — DATA-driven labels (L090, no key enum in code)", () => {
  it("explicit cohort/role label overrides win over humanized keys", () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      by_cohort: { "federer-masterclass": { gross_cents: 100, net_cents: 100, count: 1 } },
      by_event_role: { subtract: { total_cents: 50, count: 1 } },
    };
    const d = presentRevenue(view, {
      currency: "EUR",
      cohortLabels: { "federer-masterclass": "Federer Master Class" },
      roleLabels: { subtract: "Refunds & reversals" },
    });
    expect(d.currency).toBe("EUR");
    expect(d.metrics.every((m) => m.currency === "EUR")).toBe(true);
    expect(d.cohorts[0].label).toBe("Federer Master Class");
    expect(d.roles[0].label).toBe("Refunds & reversals");
  });

  it("blank override falls back to the humanized key", () => {
    const view: RevenueView = {
      ...EMPTY_VIEW,
      by_cohort: { the_book: { gross_cents: 100, net_cents: 100, count: 1 } },
    };
    const d = presentRevenue(view, { cohortLabels: { the_book: "   " } });
    expect(d.cohorts[0].label).toBe("The Book");
  });
});

describe("humanizeKey", () => {
  it("title-cases hyphen/underscore keys", () => {
    expect(humanizeKey("federer-masterclass")).toBe("Federer Masterclass");
    expect(humanizeKey("recurring_active_cents")).toBe("Recurring Active Cents");
  });
  it("returns the raw key when it has no humanizable content", () => {
    expect(humanizeKey("")).toBe("");
    expect(humanizeKey("---")).toBe("---");
  });
});
