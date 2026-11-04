// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/nudge-gate.ts.
// packages/progression-evaluator/read-data/nudge-gate.ts
//
// MNT03 — the SDT-aware, FAIL-CLOSED adherence nudge gate (the owner's "no shame, no
// streak-punishment"). When the adherence model (a LightGBM+isotonic adherence_risk_7d
// estimator — a process-job/training recipe, DATA-deferred) says an athlete is at risk of
// dropping off, this gate decides whether to nudge AND guarantees the nudge is autonomy-
// supportive (Self-Determination Theory), never controlling/shaming. Fail-closed here means
// err toward NOT nudging: unknown risk, rate-limit reached, or athlete opt-out => no nudge
// (under-nudging is safe; OVER-nudging is the harm — nagging erodes intrinsic motivation).
//
// The tone is a literal "autonomy_supportive" — the TYPE makes a shame/controlling nudge
// unrepresentable. Rate limiting is NOT re-owned here: ai-action-guard (ai-guard-limit) owns
// the nudge-per-period cap and supplies `rate_limit_ok` via Envelope; this leaf only DECIDES.
// Pure, zero-I/O. Pairs with safety-gate.ts + verify-grounding.ts as the third output guard.

export type AdherenceContext = {
  /** adherence_risk_7d in [0,1] from the MNT03 model; null/unknown => fail closed (no nudge). */
  adherence_risk: number | null;
  /** from ai-action-guard (ai-guard-limit on the nudge action): true = still under the cap. */
  rate_limit_ok: boolean;
  /** autonomy: the athlete can switch nudges off entirely — always honored first. */
  athlete_opted_out?: boolean;
};

export type NudgeConfig = {
  /** nudge only at/above this risk (DATA). */
  riskThreshold: number;
  /** a DATA ref to an autonomy-supportive nudge template (options/rationale/choice — never shame). */
  framingRef: string;
};

export type NudgeVerdict = {
  nudge: boolean;
  /** the ONLY representable tone — there is no shame/controlling variant by construction. */
  tone: "autonomy_supportive";
  framing_ref: string | null;
  reason: string;
};

function noNudge(reason: string): NudgeVerdict {
  return { nudge: false, tone: "autonomy_supportive", framing_ref: null, reason };
}

/** Decide whether to send an adherence nudge. Order enforces the anti-harm priorities:
 *  autonomy (opt-out) > rate limit (anti-nag) > known risk (fail-closed on unknown) > threshold. */
export function decideNudge(ctx: AdherenceContext | null | undefined, config: NudgeConfig): NudgeVerdict {
  if (!ctx) return noNudge("no adherence context — fail closed (no nudge)");
  // 1) AUTONOMY first: an opted-out athlete is NEVER nudged.
  if (ctx.athlete_opted_out === true) return noNudge("athlete opted out — autonomy respected");
  // 2) RATE LIMIT (ai-action-guard): never exceed the nudge cap — over-nudging is the shame/nag harm.
  if (ctx.rate_limit_ok !== true) return noNudge("nudge rate limit reached — avoid nagging");
  // 3) FAIL-CLOSED on unknown risk: do not nudge when we cannot establish elevated risk.
  if (ctx.adherence_risk == null || !Number.isFinite(ctx.adherence_risk)) {
    return noNudge("adherence risk unknown — fail closed (no nudge)");
  }
  // 4) Threshold: only nudge at elevated risk, always autonomy-supportive.
  if ((ctx.adherence_risk as number) >= config.riskThreshold) {
    return { nudge: true, tone: "autonomy_supportive", framing_ref: config.framingRef, reason: "elevated adherence risk — autonomy-supportive nudge" };
  }
  return noNudge("adherence risk below threshold — no nudge");
}
