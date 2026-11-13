// src/price-experiments.mjs
//
// PURPOSE
//   Experiments as records an account (or the service's own book) keeps, and the one way any experiment is served,
//   measured and settled. An arm is a typed variant: a price (amount_cents, read from the offer it names) is one kind,
//   and anything else a caller serves (an introduction's words, a send time, a title) is a `variant` arm
//   (src/price-experiments.json `kinds`). Trillion's own plan prices are kept in the service's book (src/record-book.mjs,
//   src/book-handlers.mjs) and published to the Worker's payment config (src/payment.mjs); anyone else tests prices of
//   their own offers the same way, through tool:run-price-experiments. Every moment (a person shown a price, a payment, a refund) is a commercial event
//   (src/commercial-events.mjs), so the funnel graph that names the experiment's funnel_id counts it at whatever stage
//   that graph's DATA says, and a settled experiment's winner is the price the graph shows at its node.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One record shape: { id, label, surface, optimizing_for, arms: [{ id, label, weight, amount_cents, currency,
//      interval, offer_id?, price_id? } | { id, label, weight, variant }], funnel_id?, node_ref?, state, result? }, every
//      arm of one experiment one kind. No other experiment shape exists.
//   2. An observer always lands on the same arm of a running experiment (choose-per-observer's sticky_hash over the
//      arms' weights); a settled experiment shows its winner to everyone; a stopped one shows none of its arms.
//   3. An arm's price is read from the offer it names when the account has that offer, never typed over it.
//   4. Blind: nothing here names a payment service, an offer, a surface or an event word; event words, the moments
//      that convert and the measure are DATA per arm kind (src/price-experiments.json `kinds`).
//   5. An experiment may carry a price rule (src/geometric-pricing.mjs): its arms are then the rule's prices, each
//      round re-centres them on what people did, and the rule's own reading is part of the results. A rule is read
//      from the experiment, else from `rules` DATA naming the experiment. Arms that are the service's own offers are
//      never re-priced here: their price belongs to whoever sets the offer.
//
import { scoreCandidates } from '../../../funnels-screen/read-data/score-candidates.ts';
import settings from './price-experiments.json' with { type: 'json' };
import { forget, nameIn } from './kept-reads.mjs';
import { PriceRuleError, armsAt, cleanRule, nextRound, openingArms, priceRuleMoney, priceRuleWords, readRule } from '../../../price-and-sell-by-contract/src/geometric-pricing.mjs';
import {sameValue} from './shipped-defaults.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const say = (words, facts) => words.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(facts, name) ? String(facts[name]) : whole));
const ENTITY = 'price-experiment:';

export class PriceExperimentError extends Error {}

/** An arm's kind: a variant arm carries `variant`; every other arm is a price. */
export const armKind = arm => (object(arm?.variant) ? 'variant' : 'price');
/** The DATA of an experiment's kind (its arms are all one kind). */
const kindOf = experiment => settings.kinds[armKind(experiment.arms[0])];
/** The event word of one moment of one kind (`shown`, or a moment that converts or takes back), for callers that keep
 *  their own events and read them with experimentResults. */
export const eventWord = (kind, moment) => settings.kinds[kind].events[moment];

/** The offer an arm stands for: its offer id, else its price id, else its own id. */
export const armKey = arm => arm.offer_id ?? arm.price_id ?? arm.id;
/** The arm of `experiment` whose id or offer is `key`, or undefined. */
export const armOf = (experiment, key) => experiment.arms.find(arm => arm.id === key || armKey(arm) === key);

/** The arm an observer is shown: the sticky arm of a running experiment among the arms `isOpen` lets through, the
 *  winner of a settled one (when open), none of a stopped one. Pure; the same answer every time. */
export function assignArm(observer, experiment, isOpen = () => true) {
  if (experiment.state === 'stopped') return null;
  if (experiment.state === 'settled') {
    const winner = armOf(experiment, experiment.result?.winner);
    return winner && isOpen(winner) ? winner.id : null;
  }
  const split = Object.fromEntries(experiment.arms.filter(arm => arm.weight > 0 && isOpen(arm)).map(arm => [arm.id, arm.weight]));
  if (!Object.keys(split).length) return null;
  const surface = { address: experiment.id, candidates: Object.keys(split).map(candidate_id => ({ candidate_id })) };
  const decider = { accepts_trust: [], score: { op: 'sticky_hash', of: { fact_path: ['observer'] }, split: { split } } };
  const facts = [{ path: ['observer'], value: `${experiment.id}:${observer}`, trust_ref: 'trust:this-service' }];
  return scoreCandidates(surface, facts, decider).winner?.candidate_id ?? null;
}

/** The offers one observer is shown: every offer that is no experiment's arm, the arms chosen for them (`chosen`, arm
 *  ids or offer keys), and any offer they already hold (`holds`). `keyOf` reads an offer's key. */
export function shownOffers({ offers, experiments, chosen = [], holds = () => false, keyOf = offer => offer.id }) {
  const picked = new Set(chosen);
  const arms = new Map(experiments.flatMap(experiment => experiment.arms.map(arm => [armKey(arm), arm])));
  return offers.filter(offer => {
    const arm = arms.get(keyOf(offer));
    return !arm || holds(offer) || picked.has(arm.id) || picked.has(armKey(arm));
  });
}

// Seeded draws, so one reading of the same counts always says the same chance: mulberry32 over a string's own hash.
function seededRandom(seed) {
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 2654435761) >>> 0, 2166136261);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A Gamma(shape, 1) draw (Marsaglia and Tsang 2000), shape at least 1 here since every count has 1 added.
function gammaDraw(shape, random) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = Math.sqrt(-2 * Math.log(random() || Number.MIN_VALUE)) * Math.cos(2 * Math.PI * random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** How likely each arm is to bring in the most value per person shown it, by arm id, or null while nobody has
 *  converted (no arm can lead yet). Each arm's share who convert (`paid`) is drawn from Beta(paid + 1, shown - paid + 1)
 *  and times what a conversion brought in (its value per conversion, money_cents / paid, or before any its price, or one
 *  unit for a variant arm), `settings.chance.draws` times; an arm's chance is the share of draws it led. */
export function chanceBest(arms, draws = settings.chance.draws) {
  if (!arms.some(arm => arm.paid > 0) || arms.length < 2) return null;
  const random = seededRandom(JSON.stringify(arms.map(arm => [arm.arm, arm.shown, arm.paid, arm.money_cents])));
  const led = new Map(arms.map(arm => [arm.arm, 0]));
  for (let draw = 0; draw < draws; draw += 1) {
    let best = null;
    let most = -Infinity;
    for (const arm of arms) {
      const yes = gammaDraw(arm.paid + 1, random);
      const no = gammaDraw(Math.max(arm.shown - arm.paid, 0) + 1, random);
      const perPayer = arm.paid > 0 ? arm.money_cents / arm.paid : arm.amount_cents ?? settings.kinds.variant.value_unit;
      const value = (yes / (yes + no)) * perPayer;
      if (value > most) { most = value; best = arm.arm; }
    }
    led.set(best, led.get(best) + 1);
  }
  return Object.fromEntries([...led].map(([arm, count]) => [arm, count / draws]));
}

/** One experiment's results from its events: per arm the observers shown it, the observers who paid, the money in
 *  (refunds taken off) and that money per person shown it. `kept` ({ shown: { armId: observers }, own: { armId:
 *  observers } }) adds observers kept elsewhere, `own` being those that are the service's own accounts (a proof, the
 *  operator, an account since deleted: settings.own_accounts); `counted` ({ offer or arm id: visitors }) is how many
 *  different visitors the interaction counts saw shown each arm since the service's own accounts stopped being counted
 *  there (visitors without an account included, own accounts left out). `people` is the larger of the kept accounts
 *  that are not the service's own and those counted visitors, `shown` is people plus own, and every share, money per
 *  person and chance is worked out over people. `started` ({ offer or arm id: checkouts }) is how many
 *  checkouts were started on each arm. */
export function experimentResults(experiment, events, kept = {}, counted = {}, started = {}) {
  const per = new Map(experiment.arms.map(arm => [arm.id, { shown: new Set(), own: new Set(), paid: new Set(), cents: 0 }]));
  for (const [armId, observers] of Object.entries(kept.shown ?? {})) for (const observer of observers) per.get(armId)?.shown.add(observer);
  for (const [armId, observers] of Object.entries(kept.own ?? {})) for (const observer of observers) { per.get(armId)?.shown.add(observer); per.get(armId)?.own.add(observer); }
  const kind = kindOf(experiment);
  const converts = new Set(kind.converts.map(moment => kind.events[moment]));
  const takesBack = new Set(kind.takes_back.map(moment => kind.events[moment]));
  const valueOf = event => event.amount_cents ?? kind.value_unit ?? 0;
  for (const event of events) {
    const row = per.get(event.arm);
    if (!row) continue;
    if (event.event === kind.events.shown) row.shown.add(event.subject_id);
    if (converts.has(event.event)) { row.paid.add(event.subject_id); row.shown.add(event.subject_id); row.cents += valueOf(event); }
    if (takesBack.has(event.event)) row.cents -= valueOf(event);
  }
  const arms = experiment.arms.map(arm => {
    const row = per.get(arm.id);
    const visitors = Number(counted[arm.id] ?? 0) + (arm.offer_id && arm.offer_id !== arm.id ? Number(counted[arm.offer_id] ?? 0) : 0);
    const people = Math.max(row.paid.size, row.shown.size - row.own.size, visitors);
    const shown = people + row.own.size;
    const served = armKind(arm) === 'variant' ? { variant: arm.variant } : { amount_cents: arm.amount_cents, currency: arm.currency, interval: arm.interval ?? null };
    return {
      arm: arm.id, label: arm.label, ...served, weight: arm.weight,
      shown, own: row.own.size, people, checkout_started: Number(started[arm.id] ?? 0) + (arm.offer_id && arm.offer_id !== arm.id ? Number(started[arm.offer_id] ?? 0) : 0), converted: row.paid.size, paid: row.paid.size, money_cents: row.cents, money_per_shown_cents: people ? Math.round(row.cents / people) : null,
    };
  });
  const earning = arms.filter(arm => arm.money_cents > 0).sort((a, b) => b.money_per_shown_cents - a.money_per_shown_cents);
  // Each arm's share who paid, and how likely it is to bring in the most money per person shown (null before any
  // payment), both over the people shown it.
  const chance = chanceBest(arms.map(arm => ({ ...arm, shown: arm.people })));
  const withChance = arms.map(arm => ({ ...arm, paid_share: arm.people ? arm.paid / arm.people : null, chance_best: chance ? chance[arm.arm] : null }));
  return { id: experiment.id, label: experiment.label, state: experiment.state, measure: kind.measure, optimizing_for: experiment.optimizing_for, arms: withChance, leading: earning[0]?.arm ?? null, ...(experiment.result ? { result: experiment.result } : {}) };
}

/** One price as words: "$9/month". */
export const priceWords = arm => `${new Intl.NumberFormat('en-US', { style: 'currency', currency: (arm.currency ?? 'usd').toUpperCase() }).format(arm.amount_cents / 100)}${arm.interval ? `/${arm.interval}` : ''}`;

/** One caller's arm as a kept arm: a variant arm as it was given, a price arm with its price read from `offers` (Map
 *  key → { label, amount_cents, currency, interval }) when the account has it. */
function cleanArm(raw, index, offers) {
  if (!object(raw)) throw new PriceExperimentError(`Arm ${index + 1} must be an object.`);
  const weight = raw.weight ?? 1;
  if (!Number.isFinite(weight) || weight < 0) throw new PriceExperimentError(`Arm ${index + 1}'s weight must be zero or more.`);
  if (armKind(raw) === 'variant') {
    if (!text(raw.id)) throw new PriceExperimentError(`Arm ${index + 1} needs an id.`);
    return { id: raw.id.trim(), weight, variant: raw.variant, label: text(raw.label) ? raw.label.trim() : raw.id.trim() };
  }
  const key = raw.offer_id ?? raw.price_id ?? raw.id;
  if (!text(key)) throw new PriceExperimentError(`Arm ${index + 1} needs offer_id, price_id or id.`);
  const known = offers?.get(key);
  if (offers && (raw.offer_id || raw.price_id) && !known) throw new PriceExperimentError(`Arm ${index + 1} names ${key}, which is not one of this account's offers or prices.`);
  const amount = known?.amount_cents ?? raw.amount_cents;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new PriceExperimentError(say(settings.words.arm_kind, { n: index + 1 }));
  const arm = {
    id: text(raw.id) ? raw.id : key,
    weight,
    amount_cents: amount,
    currency: String(known?.currency ?? raw.currency ?? 'usd').toLowerCase(),
    interval: known?.interval ?? raw.interval ?? null,
    ...(raw.offer_id ? { offer_id: raw.offer_id } : {}),
    ...(raw.price_id ? { price_id: raw.price_id } : {}),
  };
  return { ...arm, label: text(raw.label) ? raw.label.trim() : known?.label ?? priceWords(arm) };
}

/** A price-rule failure as the experiment error callers already handle. */
const ruled = work => {
  try { return work(); } catch (error) { throw error instanceof PriceRuleError ? new PriceExperimentError(error.message) : error; }
};

/** What an experiment's arms did, in the counts a price rule reads: per price the people shown it and the people who
 *  paid, the totals, and the price of the leading arm. */
function ruleFacts(results) {
  const observations = results.arms.map(arm => ({ amount_cents: arm.amount_cents, people: arm.people, paid: arm.paid }));
  return {
    observations,
    sales: observations.reduce((total, item) => total + item.paid, 0),
    reached: observations.reduce((total, item) => total + item.people, 0),
    leading_cents: results.arms.find(arm => arm.arm === results.leading)?.amount_cents ?? null,
  };
}

/**
 * The price experiments of one account.
 * store: { list(): records, put(entity, record) }; recordEvent(event); eventsOf(experimentId): events;
 * offers(): Map key → offer facts, or null when the account's offers cannot be read; publish(experiments) (only where
 * the account's experiments are served by this service); keptAccounts(experiment) → { shown, own } ({ armId: observers })
 * kept elsewhere, own being the service's own accounts;
 * shownCounted(experiment) → { offer or arm id: visitors } from the interaction counts; checkoutsStarted(experiment) →
 * { offer or arm id: checkouts started }; rules: [{ applies_to: experiment id, rule }] or an async supplier of that
 * list. These DATA rules are read only for experiments that carry none of their own.
 */
export function makePriceExperiments({ store, recordEvent, eventsOf, offers = async () => null, publish = null, keptAccounts = async () => ({}), shownCounted = async () => ({}), checkoutsStarted = async () => ({}), rules = [], now = () => new Date().toISOString() }) {
  if (!store || typeof store.list !== 'function' || typeof store.put !== 'function') throw new TypeError('Price experiments need the account store that keeps them.');
  const current = () => store.list().filter(row => object(row) && text(row.id));

  function read(id) {
    const experiment = current().find(row => row.id === id);
    if (!experiment) throw new PriceExperimentError(say(settings.words.no_experiment, { id: id || '(no id)' }));
    return experiment;
  }
  /** The price rule of `experiment`: its own, else the DATA row that names it (cleaned here, so a row written by hand
   *  gets the same defaults a saved rule does), else undefined. */
  const ruleOf = async experiment => {
    if (experiment.rule) return experiment.rule;
    let supplied;
    try { supplied = typeof rules === 'function' ? await rules() : rules; }
    catch (error) {
      // A private rule saved while a slow/default source was unavailable owns
      // the result. Its availability must not depend on that shared default.
      const own = read(experiment.id).rule;
      if (own) return own;
      throw error;
    }
    const own = read(experiment.id).rule;
    if (own) return own;
    if (!Array.isArray(supplied)) throw new PriceExperimentError('Default price rules must be a list.');
    const rule = supplied.find(row => row?.applies_to === experiment.id)?.rule;
    return rule && ruled(() => cleanRule(rule));
  };
  const resultsOf = async experiment => experimentResults(experiment, eventsOf(experiment.id), await keptAccounts(experiment), await shownCounted(experiment), await checkoutsStarted(experiment));
  async function keep(record) {
    store.put(`${ENTITY}${record.id}`, record);
    if (publish) await publish(current());
    return record;
  }

  return {
    list: () => {
      const experiments = current().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return { experiments, count: experiments.length };
    },
    read: ({ experiment_id } = {}) => read(experiment_id),

    /** Start (or change) an experiment: { experiment_id?, label, surface?, optimizing_for?, arms?, rule?, funnel_id?, node_ref? }.
     *  With a `rule` and no arms the arms are the rule's opening prices (a ladder's rungs, a bracket's first two). */
    async save(input = {}) {
      if (!object(input) || !text(input.label)) throw new PriceExperimentError('Give the experiment a label.');
      const earlier = current().find(row => row.id === experimentIdOf(input));
      const rule = input.rule === undefined ? earlier?.rule : ruled(() => cleanRule(input.rule));
      const wanted = Array.isArray(input.arms) && input.arms.length ? input.arms : rule && input.rule !== undefined ? openingArms(rule) : input.arms;
      if (!Array.isArray(wanted) || wanted.length < 2) throw new PriceExperimentError('An experiment needs at least two arms to test.');
      if (new Set(wanted.map(armKind)).size > 1) throw new PriceExperimentError(settings.words.one_kind);
      const known = wanted.some(raw => armKind(raw) === 'price') ? await offers() : null;
      const arms = wanted.map((raw, index) => cleanArm(raw, index, known));
      if (new Set(arms.map(arm => arm.id)).size !== arms.length) throw new PriceExperimentError('Every arm needs its own id.');
      const id = experimentIdOf(input);
      const at = now();
      const record = {
        id, kind: 'price-experiment', label: input.label.trim(),
        surface: text(input.surface) ? input.surface.trim() : earlier?.surface ?? id,
        optimizing_for: text(input.optimizing_for) ? input.optimizing_for.trim() : earlier?.optimizing_for ?? settings.kinds[armKind(arms[0])].optimizing_for,
        arms,
        ...(rule ? { rule, ...(earlier?.rounds ? { rounds: earlier.rounds } : {}) } : {}),
        ...(text(input.funnel_id) ? { funnel_id: input.funnel_id.trim() } : earlier?.funnel_id ? { funnel_id: earlier.funnel_id } : {}),
        ...(text(input.node_ref) ? { node_ref: input.node_ref.trim() } : earlier?.node_ref ? { node_ref: earlier.node_ref } : {}),
        state: 'running', started_at: earlier?.started_at ?? at, updated_at: at,
      };
      await keep(record);
      return { experiment: record, said: say(settings.words.saved, { label: record.label, arms: arms.length }) };
    },

    /** Everyone is shown `winner` from now on (the leading arm when no winner is named). */
    async settle({ experiment_id, winner, why } = {}) {
      const experiment = read(experiment_id);
      const chosen = winner ?? experimentResults(experiment, eventsOf(experiment.id), await keptAccounts(experiment), await shownCounted(experiment), await checkoutsStarted(experiment)).leading;
      const arm = chosen ? armOf(experiment, chosen) : null;
      if (!arm) throw new PriceExperimentError('Name the winning arm: no arm has brought in money yet.');
      const record = { ...experiment, state: 'settled', result: { winner: arm.id, ...(text(why) ? { why: why.trim() } : {}), settled_at: now() }, updated_at: now() };
      await keep(record);
      return { experiment: record, said: say(settings.words.settled, { label: record.label, winner: arm.label }) };
    },

    async stop({ experiment_id } = {}) {
      const record = { ...read(experiment_id), state: 'stopped', updated_at: now() };
      await keep(record);
      return { experiment: record, said: say(settings.words.stopped, { label: record.label }) };
    },

    /** The arm `observer` is shown, kept as their shown event (once per observer). */
    assign({ experiment_id, observer } = {}) {
      if (!text(observer)) throw new PriceExperimentError('Name the observer (a visitor, customer or account) the price is shown to.');
      const experiment = read(experiment_id);
      const arm = armOf(experiment, assignArm(observer, experiment));
      if (!arm) return { experiment_id: experiment.id, arm: null, state: experiment.state };
      const shown = kindOf(experiment).events.shown;
      recordEvent({
        event_id: `${experiment.id}:${shown}:${observer}`, event: shown, subject_kind: 'observer', subject_id: observer,
        experiment_id: experiment.id, arm: arm.id, ...(experiment.funnel_id ? { funnel_id: experiment.funnel_id } : {}),
      });
      const served = armKind(arm) === 'variant' ? { variant: arm.variant } : { amount_cents: arm.amount_cents, currency: arm.currency, interval: arm.interval, ...(arm.offer_id ? { offer_id: arm.offer_id } : {}), ...(arm.price_id ? { price_id: arm.price_id } : {}) };
      return { experiment_id: experiment.id, arm: arm.id, label: arm.label, ...served };
    },

    /** A conversion or a take-back on one arm, as the experiment's kind names them (a price: paid | refunded with
     *  amount_cents; a variant: converted, with amount_cents only when it brings a value of its own):
     *  { experiment_id, observer, moment, amount_cents?, event_id, occurred_at?, arm? }. */
    record({ experiment_id, observer, moment, amount_cents, currency, event_id, occurred_at, arm: armId } = {}) {
      const experiment = read(experiment_id);
      const kind = kindOf(experiment);
      const moments = [...kind.converts, ...kind.takes_back];
      const event = moments.includes(moment) ? kind.events[moment] : null;
      if (!event) throw new PriceExperimentError(say(settings.words.moment, { moments: moments.join(' or ') }));
      if (!text(observer) || !text(event_id)) throw new PriceExperimentError('Name the observer and the payment\'s own id (event_id).');
      const arm = armOf(experiment, armId ?? assignArm(observer, experiment));
      if (!arm) throw new PriceExperimentError(`${observer} is shown no arm of ${experiment.label}.`);
      const value = armKind(arm) === 'variant' ? (amount_cents === undefined ? {} : { amount_cents }) : { amount_cents, currency: (currency ?? arm.currency ?? 'usd').toUpperCase() };
      return recordEvent({
        event_id: `${experiment.id}:${event}:${event_id}`, event, subject_kind: 'observer', subject_id: observer,
        experiment_id: experiment.id, arm: arm.id, ...value,
        ...(experiment.funnel_id ? { funnel_id: experiment.funnel_id } : {}), ...(occurred_at ? { occurred_at } : {}),
      });
    },

    async results({ experiment_id } = {}) {
      const experiment = read(experiment_id);
      const results = await resultsOf(experiment);
      const rule = await ruleOf(experiment);
      return rule ? { ...results, geometric: readRule(rule, ruleFacts(results)) } : results;
    },

    /** A price rule previewed, with nothing kept: { rule } -> the prices it opens with and what it says. */
    ladder({ rule } = {}) {
      const kept = ruled(() => cleanRule(rule));
      return { rule: kept, arms: openingArms(kept), ...readRule(kept) };
    },

    /** What a price rule says the price is now: of an experiment ({ experiment_id }, from what its arms did), or of a
     *  rule and the counts handed in ({ rule, sales?, reached?, observations? }). */
    async price_now({ experiment_id, rule, sales, reached, observations } = {}) {
      if (text(experiment_id)) {
        const experiment = read(experiment_id);
        const kept = await ruleOf(experiment);
        if (!kept) throw new PriceExperimentError(say(priceRuleWords.no_rule, { label: experiment.label }));
        return readRule(kept, ruleFacts(await resultsOf(experiment)));
      }
      return readRule(ruled(() => cleanRule(rule)), { sales: sales ?? 0, reached: reached ?? 0, observations: observations ?? [] });
    },

    /** The next round of a running experiment's rule: its arms become the prices the rule now says to test, the earlier
     *  prices stay (weight zero) so what people did at them still counts. Offers are never re-priced here. */
    async next_round({ experiment_id } = {}) {
      const experiment = read(experiment_id);
      const rule = await ruleOf(experiment);
      if (!rule) throw new PriceExperimentError(say(priceRuleWords.no_rule, { label: experiment.label }));
      if (experiment.state !== 'running') throw new PriceExperimentError(say(priceRuleWords.not_running, { label: experiment.label, state: experiment.state }));
      const step = nextRound(rule, ruleFacts(await resultsOf(experiment)));
      if (!step) throw new PriceExperimentError(say(priceRuleWords.no_rounds, { mode: rule.mode }));
      const price = cents => priceRuleMoney(cents, rule.currency);
      if (step.held) return { experiment, held: true, said: say(priceRuleWords.round_held, { label: experiment.label, price: step.price_cents == null ? '' : price(step.price_cents) }) };
      const fresh = step.prices_cents.filter(cents => !experiment.arms.some(arm => arm.amount_cents === cents));
      if (fresh.length && experiment.arms.some(arm => arm.offer_id)) throw new PriceExperimentError(say(priceRuleWords.offers_need_owner, { label: experiment.label, price: price(fresh[0]) }));
      const added = armsAt(fresh, step.rule ?? rule).map((arm, index) => cleanArm(arm, index, null));
      const arms = [...experiment.arms.map(arm => ({ ...arm, weight: step.prices_cents.includes(arm.amount_cents) ? Math.max(arm.weight, 1) : 0 })), ...added];
      const at = now();
      const rounds = [...(experiment.rounds ?? []), { round: (experiment.rounds?.length ?? 0) + 2, prices_cents: step.prices_cents, at }];
      const record = { ...experiment, arms, rule: step.rule ?? rule, rounds, updated_at: at };
      // Default lookup and observations can await other owners. A later private
      // edit or source withdrawal cannot be overwritten by this earlier round.
      const latestRule = await ruleOf(read(experiment.id));
      if (!sameValue(read(experiment.id), experiment) || !sameValue(latestRule, rule)) {
        throw new PriceExperimentError('The experiment or its price rule changed. Read it again before starting the next round.');
      }
      await keep(record);
      return { experiment: record, said: say(priceRuleWords.round_saved, { label: record.label, round: rounds.at(-1).round, prices: step.prices_cents.map(price).join(', ') }) };
    },

    /** The offers `observer` is shown, with each running experiment's arm for them chosen (none of them kept). */
    async shown_offers({ observer } = {}) {
      if (!text(observer)) throw new PriceExperimentError('Name the observer the offers are for.');
      const known = await offers();
      if (!known) throw new PriceExperimentError('This account\'s offers could not be read: connect the payment service they are sold through.');
      const experiments = current();
      const listed = [...known].map(([key, offer]) => ({ key, ...offer }));
      const chosen = experiments.map(experiment => assignArm(observer, experiment)).filter(Boolean);
      return { observer, offers: shownOffers({ offers: listed, experiments, chosen, keyOf: offer => offer.key }) };
    },
  };
}

/** How the service publishes its experiments for the Worker (src/payment.mjs readPaymentConfig): each experiment under
 *  its own key (`published_prefix`{id}), written only by that experiment's own owner, so no two owners write one value;
 *  `for_worker` marks one whose every arm is one of the service's own offers. A Worker keeps them a minute; this one
 *  forgets its copy. */
export const publishTo = kv => async experiments => {
  for (const experiment of experiments) {
    const forWorker = experiment.arms.every(arm => arm.offer_id);
    await kv.put(`${settings.published_prefix}${experiment.id}`, JSON.stringify(experiment), { metadata: { for_worker: forWorker } });
  }
  await forgetPublished(kv);
};
/** The name a Worker keeps its copy of the published experiments under (src/payment.mjs readPaymentConfig). */
export const publishedKeptName = kv => nameIn(kv, `shared:${settings.published_prefix}`);
/** Forgets this isolate's copy of the published experiments, so its next read reads what an owner published. */
export const forgetPublished = kv => forget({ origin: null, name: publishedKeptName(kv) });

/** Every published experiment ({ for_worker } for only those the Worker prices), read from its own key. */
export async function publishedExperiments(kv, { for_worker = false } = {}) {
  const found = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: settings.published_prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      if (for_worker && key.metadata?.for_worker !== true) continue;
      const value = await kv.get(key.name, 'json');
      if (value) found.push(value);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return found;
}

/** The experiment id a save names: its experiment_id, else one made from its label. */
export const experimentIdOf = input => (text(input?.experiment_id) ? input.experiment_id.trim()
  : text(input?.label) ? `experiment:${input.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : null);

/** The accounts the Worker kept on each arm of a published experiment (its sticky assignment memo,
 *  price-arm:<experiment>:<account>): people shown that arm, those whose memo says `own` (the service's own accounts,
 *  src/payment.mjs isOwnAccount) apart. */
export const accountsKeptIn = kv => async experiment => {
  const prefix = `${settings.assigned_prefix}${experiment.id}:`;
  const kept = { shown: {}, own: {} };
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) {
      const arm = experiment.arms.find(item => item.offer_id === key.metadata?.offer_id);
      if (arm) (kept[key.metadata?.own === true ? 'own' : 'shown'][arm.id] ??= []).push(key.name.slice(prefix.length));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return kept;
};

const OWN_NAMES = settings.own_accounts.name_patterns.map(pattern => new RegExp(pattern, 'i'));
/** Whether an account name (its email or chosen name) is one of the service's own (settings.own_accounts). */
/** The hour (YYYY-MM-DDTHH, UTC) checkouts started on an arm are counted from (settings.funnel). */
export const checkoutsCountedFrom = settings.funnel.counted_from;
export const isOwnName = name => typeof name === 'string' && OWN_NAMES.some(pattern => pattern.test(name));

export const priceExperimentOperations = ['list', 'read', 'save', 'settle', 'stop', 'assign', 'record', 'results', 'shown_offers', 'ladder', 'price_now', 'next_round'];
export const operationWords = settings.words.operation;
