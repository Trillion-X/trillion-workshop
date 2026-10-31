// tools/evaluate-progress/read-data/evaluate-progression.ts
// A person's numbers (signals, one value per metric) select the rules whose band holds the value; each fired rule carries the adjustment the caller put on it. The evaluator knows no metric, direction or label.


import { bandContains } from './band-membership.ts';

export type ProgressionSignal = {
  metricRef: string;
  value: number;
};

export type ProgressionBand = {
  min?: number;
  max?: number;
};

export type ProgressionRule = {
  id: string;
  metricRef: string;
  band: ProgressionBand;
  adjustment: Record<string, unknown>;
  appliesTo?: string;
  label?: string;
};

export type FiredProgressionRule = {
  rule: ProgressionRule;
  metricValue: number;
};

export type ProgressionDecision = {
  fired: FiredProgressionRule[];
  adjustments: Record<string, unknown>[];
  matched: boolean;
};

export type EvaluateProgressionInput = {
  signals: ProgressionSignal[];
  rules: ProgressionRule[];
};

export function evaluateProgression(input: EvaluateProgressionInput): ProgressionDecision {
  const signals = Array.isArray(input.signals) ? input.signals : [];
  const rules = Array.isArray(input.rules) ? input.rules : [];

  const valueByMetric = new Map<string, number>();
  for (const signal of signals) {
    if (signal && typeof signal.metricRef === "string" && Number.isFinite(signal.value)) {
      valueByMetric.set(signal.metricRef, signal.value);
    }
  }

  const fired: FiredProgressionRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule.metricRef !== "string") continue;
    if (!valueByMetric.has(rule.metricRef)) continue;
    const metricValue = valueByMetric.get(rule.metricRef) as number;
    if (bandContains(metricValue, rule.band)) {
      fired.push({ rule, metricValue });
    }
  }

  return {
    fired,
    adjustments: fired.map((entry) => entry.rule.adjustment),
    matched: fired.length > 0,
  };
}
