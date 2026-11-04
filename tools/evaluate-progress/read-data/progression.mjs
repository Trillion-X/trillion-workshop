// Levels, rewards and streaks from facts, configured entirely by DATA: facts -> measures -> a band -> what a person
// can claim. The logic is the tested code from bitfield-packages, vendored into this folder (read-data/, beside it): measures run
// through progression-evaluator's deriveMeasure over its op pack (count, sum, distinct, ratio, band, rank, latest,
// quantile, formula, weighted-rank and more), levels through its band membership, rewards through its
// evaluateProgression rules, and streaks through group's habit cadence. This file only joins them.
//
// A fact is a self-describing record ({ kind, at, day, ... }); nothing here names a kind. A measure is a DATA row:
//
//   { "id": "points", "op": "weighted_count", "inputs": [{ "match": { "kind": "post" } }, { "match": { "kind": "reply" } }], "params": { "weights": [3, 1] } }
//
// `weighted_count` (each input's count times its weight) and `capped_count` (per-period, total and minimum limits, so a
// reward cannot be gamed) are the ops added to the vendored pack, injected the way derive-measure expects ops to be. Levels are one band table over one measure; rewards name a measure and the
// amount it must reach; a streak names a cadence ({ period: day | week | month, times }) and which facts count.
import { deriveMeasure } from './derive-measure.ts';
import { measureOps } from './measure-ops.ts';
import { bandIndexOf } from './band-membership.ts';
import { evaluateProgression } from './evaluate-progression.ts';
import { cadenceFromRaw, cadenceLabel, cadenceStreak, currentPeriodProgress } from './board-habit-cadence.ts';
import { habitLogFromRaw } from './board-habit.ts';

// The length of a bucket a rate cap counts within; a unit not listed here is not a rate cap.
const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

/**
 * `capped_count`: facts counted so gaming them gains nothing. params: { per: minute | hour | day | week, per_cap } counts at
 * most per_cap facts within any one bucket of that length; { cap } ends the total there; { min } makes the whole measure 0
 * until at least min facts qualify (a minimum to count at all); { weights } as in weighted_count, applied per input.
 * Every limit is optional, so the same op serves any "bounded reward" a community declares in its DATA.
 */
export function cappedCount(inputs, params = {}) {
  const size = BUCKET_MS[params.per];
  const weight = index => (typeof params.weights?.[index] === 'number' ? params.weights[index] : 1);
  const buckets = new Map();
  let total = 0;
  let qualifying = 0;
  inputs.forEach((input, index) => {
    for (const fact of input.facts) {
      if (size && Number.isFinite(params.per_cap)) {
        const at = Date.parse(fact.at);
        if (!Number.isFinite(at)) continue;
        const key = `${index}:${Math.floor(at / size)}`;
        if ((buckets.get(key) ?? 0) >= params.per_cap) continue;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      qualifying += 1;
      total += weight(index);
    }
  });
  if (Number.isFinite(params.min) && qualifying < params.min) return { value: 0 };
  return { value: Number.isFinite(params.cap) ? Math.min(total, params.cap) : total };
}

/** The ops a measure can name: the vendored pack plus weighted_count and capped_count. */
export const OPS = {
  ...measureOps,
  capped_count: cappedCount,
  weighted_count: (inputs, params) => ({ value: inputs.reduce((total, input, index) => total + input.facts.length * (typeof params.weights?.[index] === 'number' ? params.weights[index] : 1), 0) }),
};

const matches = (fact, match = {}) => Object.entries(match).every(([key, value]) => JSON.stringify(fact[key]) === JSON.stringify(value));

/** Every measure's number over facts ({ id: value }); a measure that fails or is not a number counts 0. */
export function measuresOf(facts, config) {
  return Object.fromEntries((config.measures ?? []).map(definition => {
    const fact = deriveMeasure(facts, { ...definition, inputs: definition.inputs?.length ? definition.inputs : [{}] }, OPS);
    return [definition.id, fact.ok && Number.isFinite(Number(fact.value)) ? Number(fact.value) : 0];
  }));
}

/** A streak over the days of the facts it names (config.streak: { cadence, of: { match } }), now given. */
export function streakOf(facts, streak, now = Date.now()) {
  const cadence = cadenceFromRaw(streak?.cadence);
  if (!cadence) return null;
  const log = habitLogFromRaw(facts.filter(fact => matches(fact, streak.of?.match)).map(fact => Date.parse(fact.at)));
  const progress = currentPeriodProgress(log, cadence, now);
  return { label: streak.label ?? cadenceLabel(cadence), periods: cadenceStreak(log, cadence, now), this_period: progress.done, of: progress.target };
}

/**
 * Where one person stands: every measure, their level, the next level and how far it is, which rewards they can
 * claim now (claims: how many times they already claimed each reward id), and their streak.
 */
export function standing(facts, config, claims = {}, now = Date.now()) {
  const measures = measuresOf(facts, config);
  const levels = config.levels ?? { bands: [] };
  const value = measures[levels.measure] ?? 0;
  const index = bandIndexOf(value, levels.bands);
  const next = levels.bands.slice(index + 1).find(band => typeof band.min === 'number' && band.min > value) ?? null;
  // A reward is a progression rule: its measure reaching at_least fires it.
  const fired = new Set(evaluateProgression({
    signals: Object.entries(measures).map(([metricRef, metric]) => ({ metricRef, value: metric })),
    rules: (config.rewards ?? []).map(reward => ({ id: reward.id, metricRef: reward.needs?.measure, band: { min: reward.needs?.at_least }, adjustment: { reward_id: reward.id } })),
  }).adjustments.map(adjustment => adjustment.reward_id));
  const rewards = (config.rewards ?? []).map(reward => {
    const claimed = claims[reward.id] ?? 0;
    return { id: reward.id, title: reward.title, says: reward.says ?? null, needs: reward.needs, have: measures[reward.needs?.measure] ?? 0, claimed, can_claim: fired.has(reward.id) && claimed < (reward.per_person ?? 1) };
  });
  return {
    measures,
    level: index < 0 ? null : { name: levels.bands[index].name, number: index + 1, of: levels.bands.length },
    next_level: next ? { name: next.name, needs: next.min - value, measure: levels.measure } : null,
    rewards,
    ...(config.streak ? { streak: streakOf(facts, config.streak, now) } : {}),
  };
}

/** Problems with a community's measures, levels, rewards and streak, as plain sentences (empty when it can be used). */
export function progressionProblems(config) {
  const problems = [];
  const ids = new Set();
  for (const definition of config.measures ?? []) {
    if (typeof definition?.id !== 'string' || !definition.id) problems.push('Every measure needs an id.');
    else if (ids.has(definition.id)) problems.push(`Two measures are called "${definition.id}".`);
    else ids.add(definition.id);
    if (!OPS[definition?.op]) problems.push(`Measure "${definition?.id}" uses "${definition?.op}"; a measure is one of: ${Object.keys(OPS).join(', ')}.`);
  }
  if (config.levels) {
    if (!ids.has(config.levels.measure)) problems.push(`Levels count "${config.levels.measure}", which is not one of the measures.`);
    if (!Array.isArray(config.levels.bands) || !config.levels.bands.length || config.levels.bands.some(band => typeof band?.name !== 'string' || !band.name)) problems.push('Levels need at least one band, each with a name.');
  }
  for (const reward of config.rewards ?? []) {
    if (typeof reward?.id !== 'string' || typeof reward?.title !== 'string') problems.push('Every reward needs an id and a title.');
    if (!ids.has(reward?.needs?.measure) || typeof reward?.needs?.at_least !== 'number') problems.push(`Reward "${reward?.id}" needs { measure, at_least } naming one of the measures.`);
  }
  if (config.streak && !cadenceFromRaw(config.streak.cadence)) problems.push('streak.cadence is { "period": "day" | "week" | "month", "times": a number }.');
  return problems;
}
