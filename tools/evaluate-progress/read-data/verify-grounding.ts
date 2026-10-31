// tools/evaluate-progress/read-data/verify-grounding.ts
// Each claim must cite at least one source that was really retrieved; a citation to a source that was not retrieved is a fabricated reference and fails the whole answer.


export type Citation = { source_id: string; quote?: string };
export type Claim = { text: string; citations?: Citation[] };
export type GroundingConfig = {
  minGroundedRatio: number;
};

export type ClaimVerdict = { text: string; grounded: boolean; reason: string };
export type GroundingResult = {
  grounded: boolean;
  grounded_ratio: number;
  per_claim: ClaimVerdict[];
  ungrounded_claims: string[];
  fabricated_citations: string[];
};

export function verifyGrounding(
  claims: readonly Claim[] | null | undefined,
  retrievedSourceIds: readonly string[] | null | undefined,
  config: GroundingConfig
): GroundingResult {
  const retrieved = new Set((retrievedSourceIds ?? []).filter((s) => typeof s === "string"));
  const list = Array.isArray(claims) ? claims : [];
  const per_claim: ClaimVerdict[] = [];
  const fabricated = new Set<string>();

  for (const claim of list) {
    const cites = Array.isArray(claim?.citations) ? claim.citations : [];
    if (cites.length === 0) {
      per_claim.push({ text: claim?.text ?? "", grounded: false, reason: "no citation — fail closed" });
      continue;
    }
    const supporting = cites.filter((c) => c && retrieved.has(c.source_id));
    for (const c of cites) if (c && !retrieved.has(c.source_id)) fabricated.add(c.source_id);
    per_claim.push(
      supporting.length > 0
        ? { text: claim.text ?? "", grounded: true, reason: `cited ${supporting.length} retrieved source(s)` }
        : { text: claim?.text ?? "", grounded: false, reason: "citation(s) not in retrieved set — fabricated reference" }
    );
  }

  const total = per_claim.length;
  const groundedCount = per_claim.filter((c) => c.grounded).length;
  const grounded_ratio = total === 0 ? 0 : groundedCount / total;
  const minRatio = Number.isFinite(config?.minGroundedRatio) ? config.minGroundedRatio : 1;
  const grounded = total > 0 && grounded_ratio >= minRatio && fabricated.size === 0;

  return {
    grounded,
    grounded_ratio,
    per_claim,
    ungrounded_claims: per_claim.filter((c) => !c.grounded).map((c) => c.text),
    fabricated_citations: [...fabricated],
  };
}
