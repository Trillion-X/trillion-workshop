// packages/revenue-ledger/show/revenue-finance-display.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The translation boundary (L098) between revenue-ledger's internal projection
// (`RevenueView` — integer cents + open-keyed maps) and a finished, human-facing
// finance display model. The data owner does ALL translation: a surface consumer
// receives a ready-to-render model in its OWN vocabulary and never has to know
// how revenue-ledger stores or folds events.
//
// DECOUPLING (NON-NEGOTIABLE): this module imports NOTHING from any other
// package. It does not know which shared surface primitive (visual-database or
// a metric-row strip) will render it. The mapping from
// `RevenueFinanceDisplay` to a specific primitive's input lives at the
// composition/surface seam, never inside revenue-ledger — so revenue-ledger and
// the surface primitive stay free of compile-time coupling.
//
// PRESENTATION vs DATA: amounts stay as integer cents. Currency/locale string
// formatting is the renderer's concern, not the data owner's — this keeps the
// model pure data, testable, and free of locale assumptions.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { RevenueView } from "../read-data/revenue-types";

/** A single headline finance reading. Amount is integer cents; the renderer
 *  formats it. `count` is present only for readings that count discrete things
 *  (e.g. active subscriptions). */
export type RevenueMetric = {
  id: string;
  label: string;
  amount_cents: number;
  currency: string;
  count?: number;
};

/** One row of a finance breakdown table (per cohort/offer, or per event role).
 *  Open shape: `gross_cents`/`net_cents`/`count` — never a closed per-offer or
 *  per-role enum. Keys (ids) come from event data, not from code. */
export type RevenueBreakdownRow = {
  id: string;
  label: string;
  gross_cents: number;
  net_cents: number;
  count: number;
};

/** The finished, render-ready finance model. A surface maps this onto whatever
 *  generic display primitive is wired at the composition seam. */
export type RevenueFinanceDisplay = {
  /** Headline KPI readings, in display order. */
  metrics: RevenueMetric[];
  /** Per-cohort (e.g. per-offer) breakdown, highest gross first. */
  cohorts: RevenueBreakdownRow[];
  /** Per-event-role breakdown (add/subtract/ignore buckets), highest first. */
  roles: RevenueBreakdownRow[];
  /** ISO currency used for every amount in this model. */
  currency: string;
};

/** Presentation DATA — every field here may be omitted. All keys are open maps
 *  so a new cohort/role label is a data row, never a code edit (L090).
 *  `cohortLabels`/`roleLabels` override the generic humanized key; absence falls
 *  back to a plain Title-Case of the key (never internal vocabulary). */
export type PresentRevenueOptions = {
  /** ISO currency to attach to every amount; defaults to "USD" when omitted. */
  currency?: string;
  /** id -> human label for cohort rows (e.g. offer_id -> offer name). */
  cohortLabels?: Record<string, string>;
  /** role-token -> human label for the event-role breakdown. */
  roleLabels?: Record<string, string>;
};

const DEFAULT_CURRENCY = "USD";

// Default human copy for the four structural KPI readings. These are NOT a
// closed business enumeration — they describe the fixed shape of RevenueView
// itself (gross/refunds/net/recurring), which is Physics for this projection.
// Any operator rename is a label override via PresentRevenueOptions, not code.
const METRIC_GROSS = "Gross revenue";
const METRIC_REFUNDS = "Refunds";
const METRIC_NET = "Net revenue";
const METRIC_RECURRING = "Recurring revenue";

/**
 * Translate the internal revenue projection into a finished, human-facing
 * finance display model.
 *
 * Pure and total: every `RevenueView` (including the all-zero empty view)
 * produces a well-formed `RevenueFinanceDisplay`. Breakdown rows are sorted
 * highest-gross/total first so the operator sees the biggest contributors at the
 * top regardless of map iteration order.
 */
export function presentRevenue(
  view: RevenueView,
  options: PresentRevenueOptions = {},
): RevenueFinanceDisplay {
  const currency = options.currency ?? DEFAULT_CURRENCY;

  const metrics: RevenueMetric[] = [
    { id: "gross", label: METRIC_GROSS, amount_cents: view.gross_cents, currency },
    { id: "refunds", label: METRIC_REFUNDS, amount_cents: view.refunds_cents, currency },
    { id: "net", label: METRIC_NET, amount_cents: view.net_cents, currency },
    {
      id: "recurring",
      label: METRIC_RECURRING,
      amount_cents: view.recurring_active_cents,
      currency,
      count: view.recurring_active_count,
    },
  ];

  const cohorts = Object.entries(view.by_cohort)
    .map(([key, bucket]): RevenueBreakdownRow => ({
      id: key,
      label: labelFor(key, options.cohortLabels),
      gross_cents: bucket.gross_cents,
      net_cents: bucket.net_cents,
      count: bucket.count,
    }))
    .sort(byGrossThenId);

  const roles = Object.entries(view.by_event_role)
    .map(([key, bucket]): RevenueBreakdownRow => ({
      id: key,
      label: labelFor(key, options.roleLabels),
      // A role bucket carries one total, not a gross/net split. Mirror it into
      // both columns so the same breakdown-row shape renders uniformly; the
      // surface can choose to show a single column.
      gross_cents: bucket.total_cents,
      net_cents: bucket.total_cents,
      count: bucket.count,
    }))
    .sort(byGrossThenId);

  return { metrics, cohorts, roles, currency };
}

/** Resolve a human label for an open data key: explicit DATA override wins,
 *  else a generic humanization of the key (no hardcoded key enumeration). */
function labelFor(key: string, labels?: Record<string, string>): string {
  const override = labels?.[key];
  if (override && override.trim() !== "") return override;
  return humanizeKey(key);
}

/** Turn a raw data key ("annual-plan", "event_role", "the_book") into Title
 *  Case human text. Generic string transform — names no specific key. */
export function humanizeKey(key: string): string {
  const cleaned = key.replace(/[-_]+/g, " ").trim();
  if (cleaned === "") return key;
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Stable highest-first ordering: by gross descending, ties broken by id so the
 *  output is deterministic (important for snapshot/render-state tests). */
function byGrossThenId(a: RevenueBreakdownRow, b: RevenueBreakdownRow): number {
  if (b.gross_cents !== a.gross_cents) return b.gross_cents - a.gross_cents;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
