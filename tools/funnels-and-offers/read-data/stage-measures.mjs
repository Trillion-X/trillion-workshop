// tools/funnels-and-offers/read-data/stage-measures.mjs
//
// Per-stage counts from append-only facts. `groupBy` names the field on each fact that holds a stage id; `amountField`
// names the whole-number revenue field (optional on a fact). A fact is a visit always, and a conversion when it carries
// `converted: true` or any number at `amountField`. A stage must match a whole reference identity unambiguously.
// Empty input gives zero measures; no stage or outcome name is built in. The counts, the revenue sum and the conversion
// percent are the list engine's measures (query-and-change-list-rows list-aggregates: filled, sum, share); this file only
// says which facts belong to which stage.

import { aggregateOf, measure } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';
import { findValueByRef } from './funnel-definition.mjs';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isAmount = value => typeof value === 'number' && Number.isFinite(value);
const answer = (values, id) => Number(measure(values, aggregateOf(id)) ?? 0);

export function reduceStageMeasures(facts, stageIds, groupBy, amountField) {
  const placed = new Map(stageIds.map(id => [id, []]));
  for (const raw of Array.isArray(facts) ? facts : []) {
    if (!isRecord(raw)) continue;
    const reference = raw[groupBy];
    if (typeof reference !== 'string') continue;
    const stage = findValueByRef(stageIds, reference);
    if (stage === undefined) continue;
    placed.get(stage).push(raw);
  }
  const out = {};
  for (const id of stageIds) {
    const visits = placed.get(id);
    const did = visits.map(raw => raw.converted === true || isAmount(raw[amountField]));
    const converted = visits.filter((_, place) => did[place]);
    out[id] = {
      visits: answer(visits.map(() => 1), 'filled'),
      conversions: answer(converted.map(() => 1), 'filled'),
      // Of the visits, the percent that converted, to one decimal.
      conversion_rate: answer(did.map(yes => (yes ? 1 : 0)), 'share'),
      revenue_cents: answer(converted.map(raw => raw[amountField]).filter(isAmount), 'sum'),
    };
  }
  return out;
}
