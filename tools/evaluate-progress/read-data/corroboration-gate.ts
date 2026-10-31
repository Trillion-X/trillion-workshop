// tools/evaluate-progress/read-data/corroboration-gate.ts
// A value is acted on only when every required check passed and enough of the optional ones agree. No checks means no.


export type SignalCheck = { name: string; passed: boolean; required?: boolean };

export type CorroborationVerdict = {
  permitted: boolean;
  required_failed: string[];
  corroborating: string[];
  reason: string;
};

export function corroborationGate(
  checks: readonly SignalCheck[] | null | undefined,
  minCorroborating: number
): CorroborationVerdict {
  const list = Array.isArray(checks) ? checks : [];
  if (list.length === 0) {
    return { permitted: false, required_failed: [], corroborating: [], reason: "no signals" };
  }
  const required = list.filter((c) => c.required === true);
  const optional = list.filter((c) => c.required !== true);
  const required_failed = required.filter((c) => !c.passed).map((c) => c.name);
  const corroborating = optional.filter((c) => c.passed).map((c) => c.name);

  if (required_failed.length > 0) {
    return { permitted: false, required_failed, corroborating, reason: `required failed: ${required_failed.join(", ")}` };
  }
  if (corroborating.length < minCorroborating) {
    return { permitted: false, required_failed: [], corroborating, reason: `only ${corroborating.length} corroborating, need ${minCorroborating}` };
  }
  return { permitted: true, required_failed: [], corroborating, reason: "required + quorum met" };
}
