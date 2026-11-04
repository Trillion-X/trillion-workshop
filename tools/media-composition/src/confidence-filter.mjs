// src/confidence-filter.mjs
//
// PURPOSE
//   A cheap second stage behind a noisy detector, and the rule for when an acting layer abstains or asks. The detector proposes
//   events; a tiny per-context model (a logit over the recent history's features) keeps the plausible ones; and a confidence
//   below the act threshold is never acted on silently: between ask_at and act_at the person is asked, below ask_at it abstains.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no context, feature or detector is named here. Models are rows (src/confidence-filter.json describes them) and
//      thresholds are DATA, so retraining or retuning is a data change.
//   2. Pure: the same events, models and features give the same answer.
//   3. A context with no model keeps its events (an unmodelled context is never silently emptied); a non-finite confidence
//      abstains.
//
import defaults from './confidence-filter.json' with { type: 'json' };

const number = value => typeof value === 'number' && Number.isFinite(value);
export const sigmoid = x => 1 / (1 + Math.exp(-x));

/** The probability a model gives an event's features: logistic(bias + Σ weight × feature); a missing feature counts as 0. */
export function probability(model, features = {}) {
  return sigmoid((model.bias ?? 0) + Object.entries(model.weights ?? {}).reduce((sum, [name, weight]) => sum + weight * (number(features[name]) ? features[name] : 0), 0));
}

/** The events whose context model keeps them. `contextOf(event)` and `featuresOf(event, index, events)` come from the caller. */
export function filterEvents(events, models, { contextOf, featuresOf }, config = defaults) {
  const byContext = new Map(models.map(model => [model.context, model]));
  return events.flatMap((event, index) => {
    const model = byContext.get(contextOf(event));
    if (!model) return [{ event, p: null, kept: true }];
    const p = probability(model, featuresOf(event, index, events));
    return [{ event, p, kept: p >= (model.keep_above ?? config.default_keep_above) }];
  }).filter(row => row.kept);
}

/** 'act' | 'ask' | 'abstain' for a confidence in 0..1. */
export function decide(confidence, config = defaults) {
  if (!number(confidence)) return 'abstain';
  return confidence >= config.act_at ? 'act' : confidence >= config.ask_at ? 'ask' : 'abstain';
}
