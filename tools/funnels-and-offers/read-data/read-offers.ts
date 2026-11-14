import { resolveOfferVariants } from './offer-variants.mjs';

export type CommercialPriceOption = {
  amount_cents?: number;
  compare_at_amount_cents?: number;
  compare_at_label?: string;
  currency?: string;
  id: string;
  installment_count?: number;
  /** Total due on the first subscription invoice. Absent means the ordinary recurring amount. */
  initial_amount_cents?: number;
  interval?: string;
  label: string;
  payment_timing?: string;
  // Free-trial length in days before the subscription first charges (DATA, not a
  // per-plan code branch). 0/absent → charge immediately. Flows to the payment
  // provider as trial_period_days.
  trial_days?: number;
  // Per-unit metered pricing (e.g. active seats). included_units are covered by
  // amount_cents; each unit beyond that is priced by the curve. The quote does the
  // arithmetic; no plan is named. Two DATA shapes, one generic evaluator:
  //   - `additional_unit_amount_cents`: a single flat marginal rate (legacy shape;
  //     equivalent to a one-band unbounded curve).
  //   - `unit_price_curve`: a piecewise DECELERATING curve — an ordered list of
  //     bands `{ up_to_units, unit_cents }` (cumulative boundary; null = unbounded
  //     final band). Absent both → flat price, no metering beyond included_units.
  // See unit-price-curve.ts (curveAmountCents / paidMatchesCurve).
  included_units?: number;
  additional_unit_amount_cents?: number;
  unit_price_curve?: { up_to_units?: number | null; unit_cents: number }[];
  /**
   * Additive N-dimensional pricing. Each dimension is independently evaluated
   * from DATA and added to amount_cents. `scalar` consumes one count;
   * `per_scope` consumes one count per scoped item and applies the curve to each
   * item independently (for example active seats per workspace).
   *
   * This subsumes the one-dimensional unit_count path without changing it:
   * existing offers omit charge_dimensions and continue through unit_price_curve.
   */
  charge_dimensions?: CommercialChargeDimension[];
  voluntary_amount_policy?: VoluntaryAmountPolicy;
  /**
   * A price that writes its own charges: a list of { amount_cents, days_after_signup } and an optional repeat
   * { amount_cents, interval } that continues from the last one. When present it is read as written (see
   * when-money-is-taken.ts); the older single-amount fields describe the same thing less completely.
   */
  charges?: Array<{ amount_cents: number; days_after_signup?: number }>;
  repeat?: { amount_cents: number; interval: string };
  /** How many a buyer may pick at checkout ({ minimum, maximum }); `seats` is the older name for the same range. */
  quantity?: { minimum?: number; maximum?: number };
  seats?: { minimum?: number; maximum?: number };
};

export type CommercialChargeDimension = {
  id: string;
  input_kind: 'scalar' | 'per_scope';
  label: string;
  metric: string;
  /** Units included for this dimension, or included per scoped item. */
  included_units: number;
  /** Required only for per_scope; references a scalar dimension's cardinality. */
  scope_dimension_id?: string;
  unit_price_curve: { up_to_units?: number | null; unit_cents: number }[];
};

export type VoluntaryAmountPolicy = {
  allow_custom: boolean;
  currency: string;
  highlighted_cents?: number;
  highlight_label?: string;
  max_cents?: number;
  min_cents: number;
  suggested_cents: number[];
};

export type CommercialCurriculumGroup = {
  item_count?: number;
  items: string[];
  label: string;
};

export type CheckoutOffer = {
  /** Prospective selection only; superseded offer terms remain readable for settlement. */
  supersedes_offer_ids?: string[];
  /** `false` retires the offer: what people bought keeps working, but nobody new is sold it (prospective selection only). */
  for_sale?: false;
  /** The line a buyer reads beside the pay button: what they agree to by paying. */
  checkout_note?: string;
  fulfillment_mode?: 'payment_record_only';
  access_refs: string[];
  benefits: string[];
  content_refs: string[];
  curriculum: CommercialCurriculumGroup[];
  id: string;
  label: string;
  /**
   * Self-describing post-purchase destination (L090): after a successful PAID
   * checkout for this offer, the surface navigates the buyer here (e.g. the
   * full-video watch page for a master-class offer). DATA on the offer — the
   * checkout never hardcodes a destination and never reads another package's
   * records. Offers without this field fall back to the default app entry.
   */
  post_purchase_route_path?: string;
  price_options: CommercialPriceOption[];
  /**
   * Public, non-namespaced id used by the marketing-site handoff
   * (selected_plan_id / public_offer_id). The internal `id` stays namespaced
   * (offer:bakery-subscription); this is how the handoff names it (subscription). The
   * checkout resolves the landed plan by matching this — never by parsing `id`.
   * Absent → the offer is not handoff-selectable by short name.
   */
  public_offer_id?: string;
  /**
   * Whether a checkout that was told nothing about which offers to show may
   * show this one.
   *
   * A price ladder is a sequence of offers that are made to one person over
   * time, each one reached by something naming it. Put all of them on a screen
   * at once and the person is not choosing a plan, they are watching the seller
   * bid against themselves, and the same page that was meant to close a sale
   * reads as a trick. That is what an unscoped checkout did: it showed every
   * published offer, so the full descending ladder appeared side by side.
   *
   * Absent means yes, which is what every offer that has not spoken gets, so
   * an app with one plan and an app that never thought about this both keep
   * working unchanged. An offer that is only ever made by invitation says
   * false, and from then on it appears only where something names it.
   */
  shown_without_being_named?: boolean;
  sort_order: number;
  summary: string;
};

export type SignedQuoteReservation = {
  displayTotal: string;
  expiresAt: string;
  policyHash: string;
  quoteReservationId: string;
  quoteText: string;
  signature: string;
};

export type CheckoutOfferProjection = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => Boolean(item)) : [];
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readPolicyAmount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`voluntary_amount_policy.${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function readPolicyCurrency(value: unknown, fallback: string | undefined): string {
  const currency = readString(value) ?? fallback;
  if (!currency || !/^[a-z]{3}$/i.test(currency)) {
    throw new Error('voluntary_amount_policy.currency must be a three-letter currency code.');
  }
  return currency.toLowerCase();
}

/**
 * The price-discovery controller: every sale moves the price.
 *
 *   price = start × 2^((sales − reference_sales
 *     − loss_weight × (losses − reference_nonbuyer_views)) / sales_to_double)
 *   loss_weight = target_win_rate / (1 − target_win_rate)
 *
 * `sales_to_double` is the speed knob: 1 doubles the price on every sale, 5
 * doubles it over five. `target_win_rate` is the share of people who reach
 * the price that should buy; at exactly that rate the price stops moving
 * (0.8 for qualified sales calls, a few percent for a public page). Losses are
 * the people who reached the price and did not buy. Every count is observed,
 * never typed; the price is DERIVED here, in the one reader every page and
 * every checkout goes through, so what a buyer is shown and what checkout
 * enforces cannot disagree. Amounts round to whole units so a doubling reads
 * as a price rather than as arithmetic. Optional reference counts put a
 * documented, already-observed starting state at `start_cents`; a small
 * markdown can then make a $100 reference price $99 without freezing future
 * prices or changing the observed counts.
 */
export function discoveredPriceCents(rule: {
  start_cents: number; sales_to_double: number; target_win_rate: number; sales: number; reached_price: number;
  floor_cents?: number; ceiling_cents?: number;
  reference_sales?: number; reference_nonbuyer_views?: number; price_markdown_cents?: number;
}): number {
  const lossWeight = rule.target_win_rate / (1 - rule.target_win_rate);
  const sales = Math.max(rule.sales, rule.reference_sales ?? 0);
  const reached = Math.max(rule.reached_price, sales, (rule.reference_sales ?? 0) + (rule.reference_nonbuyer_views ?? 0));
  const losses = Math.max(0, reached - sales);
  const net = (sales - (rule.reference_sales ?? 0))
    - lossWeight * (losses - (rule.reference_nonbuyer_views ?? 0));
  // A seller may state the lowest price the rule may reach (a patron minimum);
  // without one, the lowest is one whole unit.
  const priced = Math.max(rule.floor_cents ?? 100,
    Math.round((rule.start_cents * 2 ** (net / rule.sales_to_double)) / 100) * 100
      - (rule.price_markdown_cents ?? 0));
  // A seller may also state the highest the rule may reach. Floor equal to ceiling is a fixed price.
  return rule.ceiling_cents === undefined ? priced : Math.min(rule.ceiling_cents, priced);
}

/** One suggested amount as the list or the inline array states it: its value and whether it is offered. */
type SuggestionEntry = { value: unknown; shown: boolean };
/** The rows of each suggestion list an offer names, keyed by `suggestionKey(offer id, list address)`: the rows of the
 *  list that name that offer in the field `suggestion_rows.offer_field` (every row when it names none). Read by the caller. */
export type SuggestionLists = ReadonlyMap<string, readonly unknown[]>;
export const suggestionKey = (offerId: string, list: string): string => `${offerId}\n${list}`;
/** What a named list gives an offer: its suggested amounts, and its custom-amount row when it has one. */
type ListedSuggestions = { entries: SuggestionEntry[]; custom: { shown: boolean } | undefined };

/** The rows of the list an offer's `suggestion_rows` names. Every row states its `shown` switch. A suggested row states
 *  its amount (or multiple) in `value_field`. The row whose `custom_field` is true is the custom-amount choice, and its
 *  switch is allow_custom. */
function readSuggestionRows(declaration: unknown, lists: SuggestionLists | undefined, offerId: string): ListedSuggestions {
  if (!isRecord(declaration)) throw new Error('voluntary_amount_policy.suggestion_rows must be an object.');
  const list = readString(declaration.list);
  const valueField = readString(declaration.value_field);
  const shownField = readString(declaration.shown_field);
  if (!list || !valueField || !shownField) {
    throw new Error('voluntary_amount_policy.suggestion_rows requires list, value_field and shown_field.');
  }
  const customField = declaration.custom_field === undefined ? undefined : readString(declaration.custom_field);
  if (declaration.custom_field !== undefined && !customField) {
    throw new Error('voluntary_amount_policy.suggestion_rows.custom_field must name a field.');
  }
  if (declaration.offer_field !== undefined && !readString(declaration.offer_field)) {
    throw new Error('voluntary_amount_policy.suggestion_rows.offer_field must name a field.');
  }
  const rows = lists?.get(suggestionKey(offerId, list));
  if (!rows) throw new Error(`voluntary_amount_policy.suggestion_rows names ${list}, whose rows were not read.`);
  const entries: SuggestionEntry[] = [];
  let custom: { shown: boolean } | undefined;
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw new Error(`${list} row ${index} must be an object.`);
    const shown = row[shownField];
    if (typeof shown !== 'boolean') throw new Error(`${list} row ${index} must state ${shownField} as true or false.`);
    // A row without the custom field is a suggested amount; the field marks the one custom-amount row with true.
    const isCustom = customField === undefined ? undefined : row[customField];
    if (isCustom !== undefined && typeof isCustom !== 'boolean') {
      throw new Error(`${list} row ${index} must state ${customField} as true or false.`);
    }
    if (isCustom) {
      if (custom) throw new Error(`${list} has more than one custom row.`);
      custom = { shown };
      continue;
    }
    const amount = row[valueField];
    if (typeof amount !== 'number') throw new Error(`${list} row ${index} must state ${valueField} as a number.`);
    entries.push({ value: amount, shown });
  }
  return { entries: entries.sort((left, right) => (left.value as number) - (right.value as number)), custom };
}

/** The suggestions of a discovered price: the named list's entries, or the inline multiples. Never both. */
function discoveredSuggestionEntries(
  listed: SuggestionEntry[] | undefined,
  discovery: Record<string, unknown>,
): SuggestionEntry[] {
  if (listed !== undefined) {
    if (discovery.suggested_multiples !== undefined) {
      throw new Error('voluntary_amount_policy names suggestion_rows and also states price_discovery.suggested_multiples; state one.');
    }
    return listed;
  }
  if (!Array.isArray(discovery.suggested_multiples) || discovery.suggested_multiples.length === 0) {
    throw new Error('price_discovery.suggested_multiples must be a non-empty array.');
  }
  return discovery.suggested_multiples.map((multiple: unknown) => ({ value: multiple, shown: true }));
}

/** The suggestions of a fixed policy: the named list's entries, or the inline suggested_cents. Never both. */
function explicitSuggestionEntries(
  value: Record<string, unknown>,
  listed: SuggestionEntry[] | undefined,
): SuggestionEntry[] {
  if (listed !== undefined) {
    if (value.suggested_cents !== undefined || value.suggested_amount_cents !== undefined) {
      throw new Error('voluntary_amount_policy names suggestion_rows and also states suggested_cents; state one.');
    }
    return listed;
  }
  const source = Array.isArray(value.suggested_cents) ? value.suggested_cents : value.suggested_amount_cents;
  if (!Array.isArray(source)) {
    throw new Error('voluntary_amount_policy.suggested_cents must be an array.');
  }
  return source.map((amount: unknown) => ({ value: amount, shown: true }));
}

function discoveredPolicy(
  value: unknown,
  listed: SuggestionEntry[] | undefined,
): { min_cents: number; suggested_cents: number[] } {
  if (!isRecord(value)) throw new Error('price_discovery must be an object.');
  const salesToDouble = value.sales_to_double;
  if (typeof salesToDouble !== 'number' || !Number.isFinite(salesToDouble) || salesToDouble <= 0) {
    throw new Error('price_discovery.sales_to_double must be a positive number.');
  }
  const winRate = value.target_win_rate;
  if (typeof winRate !== 'number' || !(winRate > 0 && winRate < 1)) {
    throw new Error('price_discovery.target_win_rate must be between 0 and 1.');
  }
  const count = (field: string) => readNonNegativeSafeInteger(value[field] ?? 0, `price_discovery.${field}`);
  const referenceSales = count('reference_sales');
  const referenceNonbuyerViews = count('reference_nonbuyer_views');
  const markdown = count('price_markdown_cents');
  const startCents = readPolicyAmount(value.start_cents, 'price_discovery.start_cents');
  if (markdown >= startCents) throw new Error('price_discovery.price_markdown_cents must be below start_cents.');
  const floorCents = value.floor_cents === undefined ? undefined : readPolicyAmount(value.floor_cents, 'price_discovery.floor_cents');
  const ceilingCents = value.ceiling_cents === undefined ? undefined : readPolicyAmount(value.ceiling_cents, 'price_discovery.ceiling_cents');
  if (floorCents !== undefined && ceilingCents !== undefined && ceilingCents < floorCents) {
    throw new Error('price_discovery.ceiling_cents must be at least floor_cents.');
  }
  const minCents = discoveredPriceCents({
    start_cents: startCents,
    sales_to_double: salesToDouble,
    target_win_rate: winRate,
    sales: value.sales === undefined ? referenceSales : count('sales'),
    reached_price: value.reached_price === undefined ? referenceSales + referenceNonbuyerViews : count('reached_price'),
    floor_cents: floorCents,
    ceiling_cents: ceilingCents,
    reference_sales: referenceSales,
    reference_nonbuyer_views: referenceNonbuyerViews,
    price_markdown_cents: markdown,
  });
  const suggested = discoveredSuggestionEntries(listed, value).flatMap(({ value: multiple, shown }, index) => {
    if (typeof multiple !== 'number' || !(multiple >= 1)) {
      throw new Error(`price_discovery suggestion ${index} must be a multiple of at least 1.`);
    }
    return shown ? [Math.round((minCents * multiple) / 100) * 100] : [];
  });
  return { min_cents: minCents, suggested_cents: [...new Set(suggested)] };
}

/** The explicit suggested amounts: every row is range-checked (a hidden amount is still DATA), only shown ones are offered. */
function explicitSuggestedCents(
  value: Record<string, unknown>,
  listed: SuggestionEntry[] | undefined,
  minCents: number,
  maxCents: number | undefined,
): number[] {
  const amounts = explicitSuggestionEntries(value, listed).map(({ value: amount, shown }, index) => ({
    amount: readPolicyAmount(amount, `suggested_cents[${index}]`),
    shown,
  }));
  if (amounts.some(({ amount }) => amount < minCents || (maxCents != null && amount > maxCents))) {
    throw new Error('voluntary_amount_policy.suggested_cents must stay within the policy range.');
  }
  return amounts.filter(({ shown }) => shown).map(({ amount }) => amount);
}

function readVoluntaryAmountPolicy(
  value: unknown,
  optionCurrency: string | undefined,
  lists: SuggestionLists | undefined,
  offerId: string,
): VoluntaryAmountPolicy | undefined {
  if (!isRecord(value)) {
    throw new Error('voluntary_amount_policy must be an object.');
  }
  if (value.enabled === false) return undefined;
  const listed = value.suggestion_rows === undefined ? undefined : readSuggestionRows(value.suggestion_rows, lists, offerId);
  const discovered = value.price_discovery === undefined ? null : discoveredPolicy(value.price_discovery, listed?.entries);
  if (discovered && (value.min_cents != null || value.minimum_amount_cents != null || value.suggested_cents != null)) {
    throw new Error('voluntary_amount_policy with price_discovery derives min_cents and suggested_cents; it may not also state them.');
  }
  const rawMin = discovered ? discovered.min_cents : value.min_cents ?? value.minimum_amount_cents;
  const minCents = readPolicyAmount(rawMin, 'min_cents');
  const rawMax = value.max_cents ?? value.maximum_amount_cents;
  const maxCents = rawMax == null ? undefined : readPolicyAmount(rawMax, 'max_cents');
  if (maxCents != null && maxCents < minCents) {
    throw new Error('voluntary_amount_policy.max_cents must be at least min_cents.');
  }
  const suggestedCents = discovered
    ? discovered.suggested_cents
    : explicitSuggestedCents(value, listed?.entries, minCents, maxCents);
  // A named list with a custom row owns the custom choice: its switch is allow_custom, stated nowhere else.
  if (listed?.custom !== undefined && value.allow_custom !== undefined) {
    throw new Error('voluntary_amount_policy names a custom row in its suggestion list and also states allow_custom; state one.');
  }
  const allowCustom = listed?.custom === undefined ? value.allow_custom : listed.custom.shown;
  if (typeof allowCustom !== 'boolean') {
    throw new Error('voluntary_amount_policy.allow_custom must be boolean.');
  }
  if (!allowCustom && suggestedCents.length === 0) {
    throw new Error('voluntary_amount_policy must expose a selectable amount: allow_custom or a shown suggested amount.');
  }
  const hasHighlightedCents = Object.prototype.hasOwnProperty.call(value, 'highlighted_cents');
  const hasHighlightLabel = Object.prototype.hasOwnProperty.call(value, 'highlight_label');
  if (hasHighlightedCents !== hasHighlightLabel) {
    throw new Error('voluntary_amount_policy highlight metadata must include highlighted_cents and highlight_label.');
  }
  const highlightedCents = hasHighlightedCents
    ? readPolicyAmount(value.highlighted_cents, 'highlighted_cents')
    : undefined;
  const highlightLabel = hasHighlightLabel ? readString(value.highlight_label) : undefined;
  if (highlightedCents != null && !suggestedCents.includes(highlightedCents)) {
    throw new Error('voluntary_amount_policy.highlighted_cents must match a suggested amount.');
  }
  if (hasHighlightLabel && !highlightLabel) {
    throw new Error('voluntary_amount_policy.highlight_label must be a non-empty string.');
  }
  const currency = readPolicyCurrency(value.currency, optionCurrency);
  return {
    allow_custom: allowCustom,
    currency,
    ...(highlightedCents == null ? {} : { highlighted_cents: highlightedCents }),
    ...(highlightLabel ? { highlight_label: highlightLabel } : {}),
    ...(maxCents == null ? {} : { max_cents: maxCents }),
    min_cents: minCents,
    suggested_cents: suggestedCents,
  };
}

function readNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function readChargeDimensionCurve(
  value: unknown,
  includedUnits: number,
  dimensionId: string,
): CommercialChargeDimension['unit_price_curve'] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`charge_dimensions.${dimensionId}.unit_price_curve must be non-empty.`);
  }
  let previousBoundary = includedUnits;
  let sawUnbounded = false;
  const steps = value.map((rawStep, index) => {
    if (!isRecord(rawStep)) {
      throw new Error(`charge_dimensions.${dimensionId}.unit_price_curve[${index}] must be an object.`);
    }
    const unitCents = readNonNegativeSafeInteger(
      rawStep.unit_cents,
      `charge_dimensions.${dimensionId}.unit_price_curve[${index}].unit_cents`,
    );
    const rawBoundary = rawStep.up_to_units;
    if (rawBoundary == null) {
      if (index !== value.length - 1 || sawUnbounded) {
        throw new Error(`charge_dimensions.${dimensionId} must have one final unbounded curve band.`);
      }
      sawUnbounded = true;
      return { up_to_units: null, unit_cents: unitCents };
    }
    const boundary = readNonNegativeSafeInteger(
      rawBoundary,
      `charge_dimensions.${dimensionId}.unit_price_curve[${index}].up_to_units`,
    );
    if (sawUnbounded || boundary <= previousBoundary) {
      throw new Error(`charge_dimensions.${dimensionId} curve boundaries must increase above included_units.`);
    }
    previousBoundary = boundary;
    return { up_to_units: boundary, unit_cents: unitCents };
  });
  if (!sawUnbounded) {
    throw new Error(`charge_dimensions.${dimensionId} must have one final unbounded curve band.`);
  }
  return steps;
}

function readChargeDimensions(value: unknown): CommercialChargeDimension[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error('charge_dimensions must contain between 1 and 32 dimensions.');
  }
  const dimensions = value.map((rawDimension, index) => {
    if (!isRecord(rawDimension)) {
      throw new Error(`charge_dimensions[${index}] must be an object.`);
    }
    const id = readString(rawDimension.id);
    const label = readString(rawDimension.label);
    const metric = readString(rawDimension.metric);
    const inputKind = readString(rawDimension.input_kind);
    if (!id || !label || !metric || (inputKind !== 'scalar' && inputKind !== 'per_scope')) {
      throw new Error(`charge_dimensions[${index}] requires id, label, metric, and scalar|per_scope input_kind.`);
    }
    const includedUnits = readNonNegativeSafeInteger(
      rawDimension.included_units,
      `charge_dimensions.${id}.included_units`,
    );
    const scopeDimensionId = readString(rawDimension.scope_dimension_id);
    if (inputKind === 'scalar' && scopeDimensionId) {
      throw new Error(`charge_dimensions.${id} scalar input cannot declare scope_dimension_id.`);
    }
    if (inputKind === 'per_scope' && !scopeDimensionId) {
      throw new Error(`charge_dimensions.${id} per_scope input requires scope_dimension_id.`);
    }
    return {
      id,
      input_kind: inputKind,
      label,
      metric,
      included_units: includedUnits,
      ...(scopeDimensionId ? { scope_dimension_id: scopeDimensionId } : {}),
      unit_price_curve: readChargeDimensionCurve(rawDimension.unit_price_curve, includedUnits, id),
    } satisfies CommercialChargeDimension;
  });
  const ids = new Set<string>();
  for (const dimension of dimensions) {
    if (ids.has(dimension.id)) throw new Error(`charge_dimensions contains duplicate id ${dimension.id}.`);
    ids.add(dimension.id);
  }
  for (const dimension of dimensions) {
    if (!dimension.scope_dimension_id) continue;
    const scope = dimensions.find((candidate) => candidate.id === dimension.scope_dimension_id);
    if (!scope || scope.input_kind !== 'scalar') {
      throw new Error(`charge_dimensions.${dimension.id}.scope_dimension_id must reference a scalar dimension.`);
    }
  }
  return dimensions;
}

function readPriceOptions(value: unknown, lists: SuggestionLists | undefined, offerId: string): CommercialPriceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option, index) => {
    if (!isRecord(option)) return [];
    const id = readString(option.id) ?? `price:${index}`;
    const label = readString(option.label);
    const amountCents = typeof option.amount_cents === 'number' ? option.amount_cents : undefined;
    const compareAtAmountCents = typeof option.compare_at_amount_cents === 'number' ? option.compare_at_amount_cents : undefined;
    const compareAtLabel = readString(option.compare_at_label);
    const currency = readString(option.currency);
    const installmentCount = typeof option.installment_count === 'number' ? option.installment_count : undefined;
    const initialAmountCents = typeof option.initial_amount_cents === 'number' ? option.initial_amount_cents : undefined;
    const interval = readString(option.interval);
    const paymentTiming = readString(option.payment_timing);
    const trialDays = typeof option.trial_days === 'number' ? option.trial_days : undefined;
    const includedUnits = typeof option.included_units === 'number' ? option.included_units : undefined;
    const additionalUnitAmountCents = typeof option.additional_unit_amount_cents === 'number' ? option.additional_unit_amount_cents : undefined;
    const unitPriceCurve = Array.isArray(option.unit_price_curve)
      ? option.unit_price_curve.flatMap((step) => {
          if (!isRecord(step) || typeof step.unit_cents !== 'number') return [];
          const upTo = typeof step.up_to_units === 'number' ? step.up_to_units : null;
          return [{ up_to_units: upTo, unit_cents: step.unit_cents }];
        })
      : undefined;
    const chargeDimensions = readChargeDimensions(option.charge_dimensions);
    const voluntaryAmountPolicy = Object.prototype.hasOwnProperty.call(option, 'voluntary_amount_policy')
      ? readVoluntaryAmountPolicy(option.voluntary_amount_policy, currency, lists, offerId)
      : undefined;
    if (chargeDimensions && (
      includedUnits != null
      || additionalUnitAmountCents != null
      || (unitPriceCurve && unitPriceCurve.length > 0)
      || voluntaryAmountPolicy
    )) {
      throw new Error(`price option ${id} cannot combine charge_dimensions with legacy or voluntary metering fields.`);
    }
    // A discovered price moves, so the option's own amount follows the live
    // minimum rather than a number typed when the price was lower.
    const effectiveAmountCents = voluntaryAmountPolicy && isRecord(option.voluntary_amount_policy)
      && option.voluntary_amount_policy.price_discovery !== undefined
      ? voluntaryAmountPolicy.min_cents
      : amountCents;
    return label ? [{
      ...(effectiveAmountCents == null ? {} : { amount_cents: effectiveAmountCents }),
      ...(compareAtAmountCents == null ? {} : { compare_at_amount_cents: compareAtAmountCents }),
      ...(compareAtLabel ? { compare_at_label: compareAtLabel } : {}),
      ...(currency ? { currency } : {}),
      id,
      ...(installmentCount == null ? {} : { installment_count: installmentCount }),
      ...(initialAmountCents == null ? {} : { initial_amount_cents: initialAmountCents }),
      ...(interval ? { interval } : {}),
      label,
      ...(paymentTiming ? { payment_timing: paymentTiming } : {}),
      ...(trialDays == null ? {} : { trial_days: trialDays }),
      ...(includedUnits == null ? {} : { included_units: includedUnits }),
      ...(additionalUnitAmountCents == null ? {} : { additional_unit_amount_cents: additionalUnitAmountCents }),
      ...(unitPriceCurve && unitPriceCurve.length > 0 ? { unit_price_curve: unitPriceCurve } : {}),
      ...(chargeDimensions ? { charge_dimensions: chargeDimensions } : {}),
      ...(voluntaryAmountPolicy ? { voluntary_amount_policy: voluntaryAmountPolicy } : {}),
      ...(Array.isArray(option.charges) ? { charges: option.charges } : {}),
      ...(isRecord(option.repeat) ? { repeat: option.repeat } : {}),
      ...(isRecord(option.quantity) ? { quantity: option.quantity } : {}),
      ...(isRecord(option.seats) ? { seats: option.seats } : {}),
    }] : [];
  });
}

function readCurriculum(value: unknown): CommercialCurriculumGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group) => {
    if (!isRecord(group)) return [];
    const label = readString(group.label);
    if (!label) return [];
    const itemCount = typeof group.item_count === 'number' ? group.item_count : undefined;
    return [{
      ...(itemCount == null ? {} : { item_count: itemCount }),
      items: readStringArray(group.items),
      label,
    }];
  });
}

function recordList(projection: CheckoutOfferProjection): unknown[] {
  if (Array.isArray(projection)) return projection;
  if (isRecord(projection) && Array.isArray(projection.records)) return projection.records;
  return [];
}

export function readCheckoutOffers(
  projection: CheckoutOfferProjection,
  options: { includeSuperseded?: boolean; suggestionLists?: SuggestionLists } = {},
): CheckoutOffer[] {
  const rows = resolveOfferVariants(recordList(projection));
  const offers = rows
    .flatMap((record) => {
      if (!isRecord(record) || record.kind !== 'commercial-offer') return [];
      const id = readString(record.id);
      const label = readString(record.label);
      if (!id || !label) return [];
      const postPurchaseRoutePath = readString(record.post_purchase_route_path);
      const publicOfferId = readString(record.public_offer_id);
      const checkoutNote = readString(record.checkout_note);
      return [{
        ...(Array.isArray(record.supersedes_offer_ids)
          ? { supersedes_offer_ids: readStringArray(record.supersedes_offer_ids) } : {}),
        ...(record.fulfillment_mode === 'payment_record_only'
          ? { fulfillment_mode: 'payment_record_only' as const } : {}),
        ...(record.for_sale === false ? { for_sale: false as const } : {}),
        ...(checkoutNote ? { checkout_note: checkoutNote } : {}),
        access_refs: readStringArray(record.access_refs),
        benefits: readStringArray(record.benefits),
        content_refs: readStringArray(record.content_refs),
        curriculum: readCurriculum(record.curriculum),
        id,
        label,
        ...(postPurchaseRoutePath ? { post_purchase_route_path: postPurchaseRoutePath } : {}),
        price_options: readPriceOptions(record.price_options, options.suggestionLists, id),
        ...(publicOfferId ? { public_offer_id: publicOfferId } : {}),
        // Only an explicit `false` withholds an offer. Anything else, including
        // a missing field, is an offer that may be shown, so nothing that has
        // not spoken changes behaviour.
        ...(record.shown_without_being_named === false
          ? { shown_without_being_named: false } : {}),
        sort_order: readNumber(record.sort_order, 0),
        summary: readString(record.summary) ?? '',
      }];
    })
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (new Set(offers.map(offer => offer.id)).size !== offers.length) {
    throw new Error('Duplicate immutable checkout offer identity.');
  }
  if (options.includeSuperseded) return offers;
  const superseded = new Set(offers.flatMap((offer) => offer.supersedes_offer_ids ?? []));
  const selected = offers.filter((offer) => !superseded.has(offer.id) && offer.for_sale !== false);
  for (const offer of selected) {
    if (offer.public_offer_id) findCheckoutOfferBySelector(selected, offer.public_offer_id);
  }
  return selected;
}

/**
 * Resolve a public checkout selector without teaching the caller an offer's
 * namespace. Public CTAs may use the stable public_offer_id; internal callers
 * may use the canonical namespaced id. In both cases the selected offer and
 * its price still come exclusively from the current offer DATA.
 */
export function findCheckoutOfferBySelector<T extends { id: string; public_offer_id?: string }>(
  offers: readonly T[],
  selector: string | null | undefined,
): T | undefined {
  const requested = typeof selector === 'string' ? selector.trim() : '';
  if (!requested) return undefined;
  const matches = offers.filter((offer) => offer.id === requested || offer.public_offer_id === requested);
  if (matches.length > 1) throw new Error(`Ambiguous checkout offer selector: ${requested}`);
  return matches[0];
}
