// src/plan-needs.mjs
//
// What a person on a plan without a feature is told when they reach it, read from src/plan-comparison.json alone. It is
// its own file so a page that only says "this needs a plan" (src/workspace/failure.ts, upload.ts) carries the feature
// rows and not every offer the plans are judged from (src/plan-comparison.mjs reads the offer records).
import comparison from './plan-comparison.json' with { type: 'json' };

/** The feature row's `needs_plan` (by the refusal's feature id), else the comparison's own `words.needs_plan`. Every
 *  place that offers the plan says this. */
export const needsPlanTitle = featureId => comparison.features.find(row => row.id === featureId)?.needs_plan ?? comparison.words.needs_plan;

/** The one button of a plan state when no plan is named: the comparison's own `words.needs_plan_action`. */
export const needsPlanAction = () => comparison.words.needs_plan_action;
