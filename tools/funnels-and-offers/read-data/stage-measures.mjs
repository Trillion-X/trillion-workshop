// tools/funnels-and-offers/read-data/stage-measures.mjs
//
// Per-stage counts from append-only facts. `groupBy` names the field on each fact that holds a stage id; `amountField`
// names the whole-number revenue field (optional on a fact). A fact is a visit always, and a conversion when it carries
// `converted: true` or any number at `amountField`. A stage must match a whole reference identity unambiguously.
// Empty input gives zero measures; no stage or outcome name is built in.

import { findValueByRef } from './funnel-definition.mjs';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function reduceStageMeasures(facts, stageIds, groupBy, amountField) {
  const out = {};
  for (const id of stageIds) out[id] = { visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 };
  for (const raw of Array.isArray(facts) ? facts : []) {
    if (!isRecord(raw)) continue;
    const reference = raw[groupBy];
    if (typeof reference !== 'string') continue;
    const stage = findValueByRef(stageIds, reference);
    if (stage === undefined) continue;
    const measures = out[stage];
    measures.visits += 1;
    const amount = raw[amountField];
    const hasAmount = typeof amount === 'number' && Number.isFinite(amount);
    if (raw.converted === true || hasAmount) {
      measures.conversions += 1;
      if (hasAmount) measures.revenue_cents += amount;
    }
  }
  for (const id of stageIds) {
    const measures = out[id];
    measures.conversion_rate = measures.visits > 0 ? Math.round((measures.conversions / measures.visits) * 1000) / 10 : 0;
  }
  return out;
}
