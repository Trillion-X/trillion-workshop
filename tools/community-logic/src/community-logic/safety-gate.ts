// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/safety-gate.ts.
// packages/progression-evaluator/read-data/safety-gate.ts
//
// MNT07 — the REQUIRED, NON-REMOVABLE safety substrate (L112): a fail-closed crisis gate that
// runs BEFORE any mental/performance coaching output and SUPPRESSES it when a crisis red-flag
// (self-harm, disordered eating, abuse, severe burnout) is present at/above a DATA threshold —
// or when the check could not run at all. "Fail-closed" means the ONLY way to reach
// deliver_coaching=true is a present, evaluated, below-threshold assessment; a missing/unknown
// assessment yields SUPPRESS + route-to-support (you cannot prove the athlete is safe, so you
// do not coach). This is the gauntlet's safety analog of SP5 (zero fallback): the absence of
// the safety component is itself the closed/safe state, never a bypass.
//
// Pure, zero-I/O leaf. Generic: the threshold, the crisis categories, and the support resources
// are all DATA (names no specific crisis term in logic). The crisis DETECTION itself is a
// separate process-job (text/affect classifier, MNT04/06) that produces the CrisisAssessment;
// this leaf only DECIDES. Reconciliation with ai-action-guard: that package owns automatic rate/safety
// limits (ai-guard-limit — fits the SDT anti-shame nudge cap, MNT03), NOT measure-threshold
// crisis gating; the two are complementary guards (see observation 2026-06-27-mnt07-safety-substrate.md).

/** The crisis detector's verdict (produced by a process-job; DATA in, never owned here). */
export type CrisisAssessment = {
  /** did the crisis detector actually run? false/absent => fail closed. */
  evaluated: boolean;
  /** crisis confidence in [0,1], or null if unknown/unparseable => fail closed. */
  risk: number | null;
  /** which red-flag categories fired (DATA; e.g. self_harm, disordered_eating, abuse, burnout). */
  categories?: string[];
};

/** Gate configuration — all DATA. threshold default 0.70 per the research synthesis. */
export type SafetyGateConfig = {
  threshold: number;
  /** support/crisis resources surfaced whenever coaching is suppressed (DATA records). */
  supportResources: unknown[];
};

export type SafetyVerdict = {
  /** the ONLY true path: assessment present, evaluated, risk < threshold. */
  deliver_coaching: boolean;
  route_to_safety: boolean;
  reason: string;
  /** present (non-empty) whenever coaching is suppressed — the athlete always gets support. */
  support_resources: unknown[];
  categories: string[];
};

function suppress(reason: string, config: SafetyGateConfig, categories?: string[]): SafetyVerdict {
  return {
    deliver_coaching: false,
    route_to_safety: true,
    reason,
    support_resources: Array.isArray(config.supportResources) ? config.supportResources : [],
    categories: Array.isArray(categories) ? categories : [],
  };
}

/** Evaluate the fail-closed crisis gate. Required substrate: there is NO path to
 *  deliver_coaching=true other than a present, evaluated, below-threshold assessment. */
export function evaluateSafetyGate(
  assessment: CrisisAssessment | null | undefined,
  config: SafetyGateConfig
): SafetyVerdict {
  // FAIL-CLOSED: the check did not run, or risk is unknown/non-finite -> suppress + support.
  if (!assessment || assessment.evaluated !== true || assessment.risk == null || !Number.isFinite(assessment.risk)) {
    return suppress("safety check did not run or risk unknown — fail closed", config, assessment?.categories);
  }
  // Crisis at/above threshold -> suppress performance coaching + route to safety.
  if ((assessment.risk as number) >= config.threshold) {
    return suppress("crisis risk at/above threshold — performance coaching suppressed", config, assessment.categories);
  }
  // Only here is coaching permitted.
  return { deliver_coaching: true, route_to_safety: false, reason: "below crisis threshold", support_resources: [], categories: [] };
}

/** Apply the verdict to a would-be coaching output: when suppressed, the athlete receives the
 *  support payload, NEVER the performance-coach text. One choke point — the coaching text cannot
 *  reach the athlete without passing through here (non-bypassable by construction). */
export function applySafetyGate<T>(
  verdict: SafetyVerdict,
  coachingOutput: T
): { kind: "coaching"; output: T } | { kind: "safety"; support_resources: unknown[]; categories: string[]; reason: string } {
  if (verdict.deliver_coaching) return { kind: "coaching", output: coachingOutput };
  return { kind: "safety", support_resources: verdict.support_resources, categories: verdict.categories, reason: verdict.reason };
}
