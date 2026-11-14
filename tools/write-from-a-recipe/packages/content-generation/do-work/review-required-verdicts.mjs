// A generic bridge from Content Generation's DATA policy to the calibrated
// verdict owner. An empty policy has no semantic judgment to perform; a
// declared judgment must complete and accept before owner delivery begins.
export class RequiredVerdictRejectedError extends Error {
  constructor(verdicts, rejectedId) {
    super(`Required review ${rejectedId} rejected the draft`);
    this.name = 'RequiredVerdictRejectedError';
    this.verdicts = verdicts;
    this.rejected_id = rejectedId;
  }
}

export async function reviewRequiredVerdicts(input, _context, judgeOverride) {
  const required = input?.required_verdicts ?? [];
  if (!Array.isArray(required)) throw new TypeError('required_verdicts must be a list');
  if (required.length === 0) return {accepted: true, verdicts: []};
  if (!input?.produced_item || typeof input.produced_item !== 'object' || Array.isArray(input.produced_item)) {
    throw new TypeError('produced_item is required for semantic review');
  }
  if (!Array.isArray(input.grounding) || input.grounding.length === 0) {
    throw new TypeError('supplied grounding is required for semantic review');
  }
  const judge = judgeOverride ?? (await import('../../../../shared-code/packages/ask-a-small-model-for-a-verdict/do-work/judge-content.mjs')).judgeContent;
  const verdicts = [];
  for (const [index, row] of required.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || row.target !== 'ask-a-small-model-for-a-verdict.judge-content'
      || typeof row.id !== 'string' || !row.id.trim()
      || !row.rubric || typeof row.rubric !== 'object') {
      throw new TypeError(`required_verdicts[${index}] is invalid`);
    }
    const sources = row.content_source;
    if (!Array.isArray(sources) || !sources.includes('produced-item') || !sources.includes('supplied-grounding')) {
      throw new TypeError(`required_verdicts[${index}] must inspect the produced item and supplied grounding`);
    }
    const content = JSON.stringify({supplied_grounding: input.grounding, produced_item: input.produced_item});
    const result = await judge({rubric: row.rubric, content,
      providers: Array.isArray(input.providers) ? input.providers : undefined,
      passes: Number.isSafeInteger(input.passes) ? input.passes : undefined});
    verdicts.push({id: row.id, accepted: result?.accepted === true, verdict: result});
    if (result?.accepted !== true) throw new RequiredVerdictRejectedError(verdicts, row.id);
  }
  return {accepted: true, verdicts};
}

export const run = reviewRequiredVerdicts;
