// tools/evaluate-progress/read-data/risk-gate.ts
// A fail-closed gate that runs before an output is released. The output goes out only when a risk assessment was really made, the risk is a number, and it is under the caller's threshold.
// A missing, unfinished or unreadable assessment, or a threshold that is not a number, holds the output back (a gate that cannot tell may not release). Whenever the output is held back the caller's own
// support resources come with the answer. The threshold, the categories and the resources are the caller's.

export type RiskAssessment = {
  evaluated: boolean;
  risk: number | null;
  categories?: string[];
};

export type RiskGateConfig = {
  threshold: number;
  supportResources?: unknown[];
};

export type RiskVerdict = {
  release: boolean;
  hold_back: boolean;
  reason: string;
  support_resources: unknown[];
  categories: string[];
};

function holdBack(reason: string, config: RiskGateConfig, categories?: string[]): RiskVerdict {
  return {
    release: false,
    hold_back: true,
    reason,
    support_resources: Array.isArray(config?.supportResources) ? config.supportResources : [],
    categories: Array.isArray(categories) ? categories : [],
  };
}

export function evaluateRiskGate(assessment: RiskAssessment | null | undefined, config: RiskGateConfig): RiskVerdict {
  if (!Number.isFinite(config?.threshold)) return holdBack('no usable threshold: held back', config, assessment?.categories);
  if (!assessment || assessment.evaluated !== true || assessment.risk == null || !Number.isFinite(assessment.risk)) {
    return holdBack('the assessment did not run or the risk is unknown: held back', config, assessment?.categories);
  }
  if (assessment.risk >= config.threshold) {
    return holdBack('risk is at or above the threshold: held back', config, assessment.categories);
  }
  return { release: true, hold_back: false, reason: 'risk is below the threshold', support_resources: [], categories: [] };
}

export function applyRiskGate<T>(
  verdict: RiskVerdict,
  output: T,
): { kind: 'output'; output: T } | { kind: 'held-back'; support_resources: unknown[]; categories: string[]; reason: string } {
  if (verdict.release) return { kind: 'output', output };
  return { kind: 'held-back', support_resources: verdict.support_resources, categories: verdict.categories, reason: verdict.reason };
}
