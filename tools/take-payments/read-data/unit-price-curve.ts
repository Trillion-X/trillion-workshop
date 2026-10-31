// packages/checkout/read-data/unit-price-curve.ts
//
// =============================================================================
// PURPOSE — the ONE generative primitive for metered (per-unit) pricing (L069)
// -----------------------------------------------------------------------------
// A price option can charge more as usage grows (e.g. active seats). The
// naive shape is ONE marginal rate (`additional_unit_amount_cents`) — a single
// straight line. Real pricing DECELERATES: the marginal price per unit DROPS as
// the count climbs (1000 seats at one rate, the next band cheaper, the next
// cheaper still). One flat rate cannot express that; N special-cased tiers would
// be an enum (a code branch per band).
//
// The primitive that expresses EVERY shape with ZERO per-band code is a
// PIECEWISE UNIT-PRICE CURVE stored as DATA: an ordered list of bands, each
// `{ up_to_units, unit_cents }` where `up_to_units` is the CUMULATIVE unit-count
// boundary the band extends to (inclusive) and `up_to_units: null` marks the
// final UNBOUNDED band. The old flat rate is just the degenerate one-band curve
// (`[{ up_to_units: null, unit_cents: rate }]`), so every existing metered offer
// keeps working through this same code with no special case (L100 subsumption).
//
// Two pure, mutually-consistent functions:
//   curveAmountCents(price, N)  -> the total for N units.
//   paidMatchesCurve(price, P)  -> true IFF P == curveAmountCents(N) for SOME
//                                  integer N >= included_units.
// The gate is the exact inverse image of the evaluator, so a paid subscription
// amount is accepted IFF some legitimate unit count produces it (fail-closed).
//
// Physics vs Society: the numbers (bands, rates, included tier) are Society DATA
// on the offer record; this file is generic Physics that walks whatever DATA it
// is handed. Deleting any one curve and dropping in ANY
// other curve as DATA needs ZERO change here.
// =============================================================================
import type { CommercialPriceOption } from '../../funnels-and-offers/read-data/read-offers.ts';

export type UnitPriceCurveStep = {
  /** Cumulative unit-count boundary this band extends to (inclusive). null = unbounded (final band). */
  up_to_units?: number | null;
  /** Marginal price per unit per period within this band, in minor units (cents). */
  unit_cents: number;
};

type NormalizedStep = { upTo: number | null; unitCents: bigint };

function boundedInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  return null; // null / 0 / negative / non-number all mean "unbounded"
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** The included tier: units already covered by the base `amount_cents` (0 when absent). */
export function includedUnits(price: CommercialPriceOption): number {
  return nonNegativeInt(price.included_units);
}

/** Base price (covers the included tier), in minor units. */
export function baseAmountCents(price: CommercialPriceOption): bigint {
  return BigInt(Math.max(0, Math.trunc(price.amount_cents ?? 0)));
}

/**
 * The price option's effective per-unit curve, ordered by ascending unit count.
 * DATA-first: an explicit `unit_price_curve` wins. Absent → fold the legacy flat
 * `additional_unit_amount_cents` into ONE unbounded band. Neither → empty curve
 * (a flat price with no metering beyond the included tier). Bands are sorted by
 * boundary with the unbounded band (null) always last, so authoring order never
 * changes the math.
 */
export function normalizeCurve(price: CommercialPriceOption): NormalizedStep[] {
  const raw = Array.isArray(price.unit_price_curve) ? price.unit_price_curve : null;
  if (raw && raw.length > 0) {
    return raw
      .map((step) => ({
        upTo: boundedInt(step?.up_to_units),
        unitCents: BigInt(nonNegativeInt(step?.unit_cents)),
      }))
      .sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo));
  }
  const flat = nonNegativeInt(price.additional_unit_amount_cents);
  return flat > 0 ? [{ upTo: null, unitCents: BigInt(flat) }] : [];
}

/**
 * Total minor units for `unitCount` units under this price option's curve:
 * base + Σ over bands of (unitsCoveredInBand · band rate). Counts at or below the
 * included tier cost exactly the base. Pure, deterministic, BigInt-exact.
 */
export function curveAmountCents(price: CommercialPriceOption, unitCount: number): bigint {
  const base = baseAmountCents(price);
  const count = Number.isFinite(unitCount) ? Math.max(0, Math.trunc(unitCount)) : 0;
  const included = includedUnits(price);
  if (count <= included) return base;

  let total = base;
  let prev = included; // cumulative boundary already covered (unit index)
  for (const step of normalizeCurve(price)) {
    const boundary = step.upTo === null ? count : Math.min(count, step.upTo);
    if (boundary > prev) {
      total += BigInt(boundary - prev) * step.unitCents;
      prev = boundary;
    }
    if (step.upTo !== null && count <= step.upTo) break;
  }
  return total;
}

/**
 * True IFF `paidCents` equals curveAmountCents(N) for SOME integer N >= included.
 * Walks bands in ascending order consuming `over = paid - base`: a bounded band
 * absorbs at most (bandWidth · rate); the band where `over` lands must divide
 * evenly by that band's rate; the unbounded final band (rate >= 1) accepts any
 * residual divisible by its rate. Fail-closed: paid below base, paid exceeding a
 * fully-bounded curve, or a non-integer residual in the landing band → false.
 * A zero-rate band adds nothing (its units are free) so it cannot consume a
 * positive residual — it is skipped.
 */
export function paidMatchesCurve(price: CommercialPriceOption, paidCents: number): boolean {
  if (!Number.isFinite(paidCents) || paidCents < 0) return false;
  const base = baseAmountCents(price);
  const paid = BigInt(Math.trunc(paidCents));
  if (paid < base) return false;
  let over = paid - base;
  if (over === 0n) return true;

  let prev = includedUnits(price);
  for (const step of normalizeCurve(price)) {
    if (step.upTo === null) {
      // Final unbounded band: any residual divisible by the rate is reachable.
      return step.unitCents > 0n ? over % step.unitCents === 0n : false;
    }
    const width = step.upTo - prev;
    prev = step.upTo;
    if (width <= 0 || step.unitCents === 0n) continue;
    const bandMax = BigInt(width) * step.unitCents;
    if (over <= bandMax) return over % step.unitCents === 0n;
    over -= bandMax;
  }
  return false; // paid exceeds a fully-bounded curve
}
