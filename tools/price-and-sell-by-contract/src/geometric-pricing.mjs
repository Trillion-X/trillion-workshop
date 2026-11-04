// src/geometric-pricing.mjs
//
// PURPOSE
//   Geometric pricing as one blind engine any offer carries as a rule record: the price moves by multiplication, from
//   what people actually did, instead of by what the seller feels. Sam's pricing workbooks hold two rules and this
//   is both of them, plus the ladder that lets a price experiment (src/price-experiments.mjs) test them:
//     ladder      prices a fixed ratio apart (start x ratio^k), so a test covers a wide range in few arms; each round
//                 zooms in by taking the square root of the ratio around the price that earned most per person.
//     controller  the Variable Speed Controller: price = start x 2^((sales - loss_weight x losses) / sales_to_double),
//                 loss_weight = target_win_rate / (1 - target_win_rate). Losses are people who reached the price and
//                 did not buy. At exactly target_win_rate the price holds still.
//     bracket     the bracketed price search: L is the highest price someone accepted, U the lowest price above L that
//                 was refused; the next quote is sqrt(L x U), or L x growth while nothing above L has been refused.
//   The controller is the same arithmetic as the checkout package's discoveredPriceCents (bitfield-packages
//   packages/checkout/read-data/read-offers.ts), adapted here with no import so Trillion runs standalone.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names an offer, a product, a person or a payment service. A rule is numbers; the counts it
//      reads (people who reached a price, people who paid) are handed in, never fetched.
//   2. Dumb: a rule never guesses a number it was not given. A missing field is a named default from
//      src/geometric-pricing.json or an error, never an invention.
//   3. A new way to move a price is one entry in `ruleModes` (clean, read, open, next); no caller branches on a mode.
//   4. Prices are whole numbers of cents rounded to `unit_cents`, so a doubling reads as a price, not arithmetic.
//   5. Changing what customers are charged is not done here: this engine says what the price should be; the owner of
//      the offer sets it.
//
import settings from './geometric-pricing.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const say = (words, facts) => words.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(facts, name) ? String(facts[name]) : whole));
const money = (cents, currency = 'usd') => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export class PriceRuleError extends Error {}

const wholeCents = (value, label, { min = 0 } = {}) => {
  if (!Number.isSafeInteger(value) || value < min) throw new PriceRuleError(`${label} must be a whole number of cents${min ? `, at least ${min}` : ''}.`);
  return value;
};
const generatedCents = (value, label) => wholeCents(value, `Generated ${label}`);
const count = (value, label, fallback) => {
  const kept = value ?? fallback;
  if (!Number.isSafeInteger(kept) || kept < 0) throw new PriceRuleError(`${label} must be a whole number, zero or more.`);
  return kept;
};
const positive = (value, label, fallback) => {
  const kept = value ?? fallback;
  if (typeof kept !== 'number' || !Number.isFinite(kept) || kept <= 0) throw new PriceRuleError(`${label} must be a number above zero.`);
  return kept;
};
const roundTo = (cents, unit) => Math.round(cents / unit) * unit;

/** The fields every mode shares: the price unit, the lowest price, and what the prices are paid in. */
function common(raw) {
  const unit = wholeCents(raw.unit_cents ?? settings.unit_cents, 'unit_cents', { min: 1 });
  return {
    unit_cents: unit,
    start_cents: wholeCents(raw.start_cents, 'start_cents', { min: 1 }),
    ...(raw.floor_cents === undefined ? {} : { floor_cents: wholeCents(raw.floor_cents, 'floor_cents') }),
    ...(raw.currency === undefined ? {} : { currency: String(raw.currency).toLowerCase() }),
    ...(raw.interval === undefined || raw.interval === null ? {} : { interval: String(raw.interval) }),
  };
}

/** The prices in an ascending list that stay between the rule's floor and ceiling, each once. */
function within(prices, rule) {
  const lowest = Math.max(rule.floor_cents ?? 0, rule.unit_cents);
  return [...new Set(prices.filter(cents => cents >= lowest && (rule.ceiling_cents === undefined || cents <= rule.ceiling_cents)))].sort((a, b) => a - b);
}

// ---- ladder -------------------------------------------------------------------------------------------------------

function ladderPrices(rule) {
  const rungs = [];
  for (let step = -rule.down_steps; step <= rule.up_steps; step += 1) rungs.push(roundTo(rule.start_cents * rule.ratio ** step, rule.unit_cents));
  // A rung excluded by the configured floor or ceiling is not an advised price. Validate every rung that survives
  // that range before it can be returned, formatted or used to open an arm.
  return within(rungs, rule).map(cents => generatedCents(cents, 'ladder price'));
}

const ladder = {
  clean(raw) {
    const rule = {
      mode: 'ladder', ...common(raw),
      ratio: positive(raw.ratio, 'ratio', settings.ladder.ratio),
      down_steps: count(raw.down_steps, 'down_steps', settings.ladder.down_steps),
      up_steps: count(raw.up_steps, 'up_steps', settings.ladder.up_steps),
      ...(raw.ceiling_cents === undefined ? {} : { ceiling_cents: wholeCents(raw.ceiling_cents, 'ceiling_cents') }),
    };
    if (rule.ratio === 1) throw new PriceRuleError('ratio of 1 gives one price; a ladder needs a ratio above or below 1.');
    if (rule.down_steps + rule.up_steps > settings.max_steps) throw new PriceRuleError(`A ladder has at most ${settings.max_steps} steps.`);
    if (ladderPrices(rule).length < 2) throw new PriceRuleError('This ladder gives fewer than two prices between its floor and ceiling.');
    return rule;
  },
  open: rule => ladderPrices(rule),
  read(rule) {
    const prices = ladderPrices(rule);
    return { prices_cents: prices, said: say(settings.words.ladder, { count: prices.length, ratio: rule.ratio, prices: prices.map(cents => money(cents, rule.currency)).join(', ') }) };
  },
  /** Zoom: the next ladder is centred on the price that earned most per person and spaced by the square root of the ratio. */
  next(rule, facts) {
    if (facts.leading_cents == null) return { held: true, price_cents: null };
    const leading = wholeCents(facts.leading_cents, 'leading_cents');
    const finer = { ...rule, start_cents: leading, ratio: Math.sqrt(rule.ratio) };
    const prices = ladderPrices(finer);
    const now = ladderPrices(rule);
    if (prices.length < 2 || (prices.length === now.length && prices.every((cents, index) => cents === now[index]))) return { held: true, price_cents: leading };
    return { held: false, rule: finer, prices_cents: prices };
  },
};

// ---- controller ---------------------------------------------------------------------------------------------------

/** The price the controller gives after `sales` people bought among `reached` who reached the price. */
export function controllerCents(rule, { sales = 0, reached = 0 } = {}) {
  const lossWeight = rule.target_win_rate / (1 - rule.target_win_rate);
  const bought = Math.max(sales, rule.reference_sales);
  const arrived = Math.max(reached, bought, rule.reference_sales + rule.reference_nonbuyer_views);
  const losses = Math.max(0, arrived - bought);
  const net = (bought - rule.reference_sales) - lossWeight * (losses - rule.reference_nonbuyer_views);
  return generatedCents(Math.max(rule.floor_cents ?? rule.unit_cents,
    roundTo(rule.start_cents * 2 ** (net / rule.sales_to_double), rule.unit_cents) - rule.price_markdown_cents), 'controller price');
}

const controller = {
  clean(raw) {
    const rule = {
      mode: 'controller', ...common(raw),
      sales_to_double: positive(raw.sales_to_double, 'sales_to_double'),
      target_win_rate: positive(raw.target_win_rate, 'target_win_rate'),
      reference_sales: count(raw.reference_sales, 'reference_sales', 0),
      reference_nonbuyer_views: count(raw.reference_nonbuyer_views, 'reference_nonbuyer_views', 0),
      price_markdown_cents: count(raw.price_markdown_cents, 'price_markdown_cents', 0),
      ...(Array.isArray(raw.suggested_multiples) ? { suggested_multiples: raw.suggested_multiples.map((multiple, index) => positive(multiple, `suggested_multiples[${index}]`)) } : {}),
    };
    if (rule.target_win_rate >= 1) throw new PriceRuleError('target_win_rate must be between 0 and 1.');
    if (rule.price_markdown_cents >= rule.start_cents) throw new PriceRuleError('price_markdown_cents must be below start_cents.');
    return rule;
  },
  open: () => [],
  read(rule, facts) {
    const price = controllerCents(rule, { sales: facts.sales, reached: facts.reached });
    return {
      price_cents: price,
      sales: facts.sales, reached: facts.reached,
      ...(rule.suggested_multiples ? { suggested_cents: [...new Set(rule.suggested_multiples.map(multiple => generatedCents(roundTo(price * multiple, rule.unit_cents), 'suggested price')))] } : {}),
      said: say(settings.words.controller, { price: money(price, rule.currency), sales: facts.sales, reached: facts.reached }),
    };
  },
  next: () => null,
};

// ---- bracket ------------------------------------------------------------------------------------------------------

/** What each price level has shown: observations ({ amount_cents, people, paid } per arm) grouped by price. */
function levels(observations) {
  const byPrice = new Map();
  for (const item of observations) {
    const amount = wholeCents(item.amount_cents, 'observed amount_cents');
    const level = byPrice.get(amount) ?? { amount_cents: amount, people: 0, paid: 0 };
    level.people += item.people ?? 0;
    level.paid += item.paid ?? 0;
    byPrice.set(amount, level);
  }
  return [...byPrice.values()].sort((a, b) => a.amount_cents - b.amount_cents);
}

/** L, U and the next quote of one bracket from what people did at each price. Only buyers update L; a price counts as
 *  refused only once enough people have reached it (reject_min_shown) without anyone buying. */
export function bracketRead(rule, observations) {
  const seen = levels(observations);
  const lowest = Math.max(rule.floor_cents ?? 0, rule.unit_cents);
  const accepted = seen.filter(level => level.paid >= rule.accept_min_paid);
  const low = accepted.length ? Math.max(...accepted.map(level => level.amount_cents)) : null;
  const refusedAbove = seen.filter(level => level.paid < rule.accept_min_paid && level.people >= rule.reject_min_shown && (low === null || level.amount_cents > low));
  const high = refusedAbove.length ? Math.min(...refusedAbove.map(level => level.amount_cents)) : null;
  const price = (cents, key) => ({ cents: generatedCents(Math.max(lowest, roundTo(cents, rule.unit_cents)), 'bracket price'), key });
  let step;
  if (low === null && high === null) step = price(rule.start_cents, 'bracket_open');
  else if (low === null) step = price(high / rule.growth, 'bracket_all_refused');
  else if (high === null) step = price(low * rule.growth, 'bracket_climb');
  else step = price(Math.sqrt(low * high), 'bracket_between');
  const converged = low !== null && high !== null && (high <= low * (1 + rule.tolerance) || step.cents <= low || step.cents >= high);
  const quote = converged ? low : step.cents;
  const currency = rule.currency;
  return {
    low_cents: low, high_cents: high, quote_cents: quote, converged,
    said: say(settings.words[converged ? 'bracket_met' : step.key], { low: low === null ? '' : money(low, currency), high: high === null ? '' : money(high, currency), price: money(quote, currency) }),
  };
}

const bracket = {
  clean(raw) {
    const rule = {
      mode: 'bracket', ...common(raw),
      growth: positive(raw.growth, 'growth', settings.bracket.growth),
      accept_min_paid: count(raw.accept_min_paid, 'accept_min_paid', settings.bracket.accept_min_paid),
      reject_min_shown: count(raw.reject_min_shown, 'reject_min_shown', settings.bracket.reject_min_shown),
      tolerance: positive(raw.tolerance, 'tolerance', settings.bracket.tolerance),
    };
    if (rule.growth <= 1) throw new PriceRuleError('growth must be above 1.');
    if (rule.accept_min_paid < 1) throw new PriceRuleError('accept_min_paid must be at least 1.');
    return rule;
  },
  open: rule => [...new Set([generatedCents(rule.start_cents, 'opening price'), generatedCents(roundTo(rule.start_cents * rule.growth, rule.unit_cents), 'opening price')])],
  read: (rule, facts) => bracketRead(rule, facts.observations),
  /** The next round tests the quote against the best price already proven (or the refused one while nothing is). */
  next(rule, facts) {
    const read = bracketRead(rule, facts.observations);
    if (read.converged) return { held: true, price_cents: read.quote_cents };
    const against = read.low_cents ?? read.high_cents;
    const prices = [...new Set([against, read.quote_cents].filter(cents => cents != null))].sort((a, b) => a - b);
    if (prices.length < 2) prices.push(generatedCents(roundTo(read.quote_cents * rule.growth, rule.unit_cents), 'next-round price'));
    return { held: false, rule, prices_cents: prices, bracket: read };
  },
};

/** How a price moves, by mode name. Each: clean(raw) -> rule, open(rule) -> opening prices, read(rule, facts) -> what
 *  the rule says now, next(rule, facts) -> the next round, { held } when there is none, or null when the mode has no rounds. */
export const ruleModes = { ladder, controller, bracket };

/** A caller's rule as a kept rule, or an error naming the modes there are. */
export function cleanRule(raw) {
  if (!object(raw)) throw new PriceRuleError('A price rule is an object with a mode and its numbers.');
  const mode = ruleModes[raw.mode];
  if (!mode) throw new PriceRuleError(`A price rule's mode is one of ${Object.keys(ruleModes).join(', ')}.`);
  return mode.clean(raw);
}

/** What `rule` says now from the counts in `facts` ({ observations, sales, reached, leading_cents }). */
export function readRule(rule, facts = {}) {
  return { mode: rule.mode, ...ruleModes[rule.mode].read(rule, { observations: [], sales: 0, reached: 0, leading_cents: null, ...facts }) };
}

/** The arms a rule opens an experiment with: one per price, ids by price so events carry across rounds. */
export function armsAt(prices, rule) {
  return prices.map((amount, index) => {
    const cents = generatedCents(amount, `experiment arm ${index + 1}`);
    return {
      id: `${settings.arm_prefix}${cents}`, amount_cents: cents,
      ...(rule.currency ? { currency: rule.currency } : {}), ...(rule.interval ? { interval: rule.interval } : {}),
    };
  });
}
export const openingArms = rule => armsAt(ruleModes[rule.mode].open(rule), rule);

/** The next round of `rule` from `facts`, or null for a mode without rounds. */
export const nextRound = (rule, facts) => ruleModes[rule.mode].next(rule, { observations: [], leading_cents: null, ...facts });

export const priceRuleWords = settings.words;
export const priceRuleMoney = (cents, currency = 'usd') => money(wholeCents(cents, 'price_cents'), currency);
