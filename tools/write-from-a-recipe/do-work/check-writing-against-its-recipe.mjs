// tools/write-from-a-recipe/do-work/check-writing-against-its-recipe.mjs
//
// tool:check-writing-against-its-recipe, run after the person's AI writes. One JSON request on standard input:
//   { recipe? | recipe_id?, writing: {...}, grounding?: [excerpt], work_item?, context?, review?: { accepted, verdicts } }
// prints { result } on its last line, in this order, stopping at the first refusal:
//   1. the recipe's gate checks against the supplied sources (read-data/check-writing.mjs evaluateGate);
//   2. the recipe's rule rows (gate_policy.rules, tools/judge-words rows) judged by judge-words over the writing: its
//      words (as gate_policy.words chooses them) for word rows, and the whole writing for path rows; only passed, or
//      held (every finding from a capped row), lets it through;
//   3. the recipe's required verdicts against the review the caller hands in;
//   4. the one handoff the recipe's delivery_target builds: { tool_id, input } for the next tool, or null when the
//      recipe names no next tool (the writing goes back to the person).
// A refusal is { passed: false, reject_code, reason, findings? } and carries no handoff.
import { text } from 'node:stream/consumers';
import { judge } from '../../judge-words/do-work/judge-words.mjs';
import { buildOwnerDelivery, evaluateGate, plainObject, requiredVerdictsMet } from '../read-data/check-writing.mjs';
import { checkEvidenceContract, evidenceProvenanceForDelivery, evidenceReviewBinding } from '../read-data/evidence-contract.mjs';
import { recipeOf } from '../read-data/library.mjs';

const refused = (reject_code, reason, extra = {}) => ({ passed: false, reject_code, reason, ...extra });

// The recipe's judge-words rows over the writing, or null when it has none.
function judgedRules(writing, policy) {
  const rules = policy.rules;
  if (rules === undefined) return null;
  if (!Array.isArray(rules) || !rules.length) throw new Error('gate_policy.rules must be a nonempty list of judge-words rule rows.');
  const words = plainObject(policy.words) ? policy.words : {};
  return judge({
    rules,
    ...(rules.some(rule => rule?.path === undefined) ? { value: writing, fields: words.fields, paths: words.paths, skip_keys: words.skip_keys, skip_paths: words.skip_paths } : {}),
    ...(rules.some(rule => rule?.path !== undefined) ? { artifact: writing } : {}),
  });
}

export function checkWritingAgainstItsRecipe(input = {}) {
  const recipe = recipeOf(input);
  if (!plainObject(input.writing)) throw new Error('writing must be the JSON object the AI wrote, in the shape the recipe\'s output_contract asks for.');
  const policy = plainObject(recipe.gate_policy) ? recipe.gate_policy : {};
  const [passed, rejectCode, rejectReason] = evaluateGate(input.writing, policy, input.grounding ?? []);
  if (!passed) return refused(rejectCode, rejectReason);
  const judged = judgedRules(input.writing, policy);
  if (judged && !['passed', 'held'].includes(judged.status)) {
    return refused(`rules_not_met:${judged.status}`, [judged.said, ...judged.lines].join(' '), { findings: judged.findings });
  }
  let evidenceReview = null;
  if (policy.evidence_contract !== undefined) {
    if (policy.evidence_contract !== 'source-backed-claims/v1') return refused('unknown_evidence_contract', 'unsupported evidence contract; refusing delivery');
    evidenceReview = checkEvidenceContract({
      evidence_packet: input.evidence_packet,
      writing: input.writing,
      review: input.review,
      required_verdicts: policy.required_verdicts,
    });
    if (!evidenceReview.passed) {
      const binding = evidenceReviewBinding({ evidence_packet: input.evidence_packet, writing: input.writing });
      return refused('evidence_contract_failed', evidenceReview.reason, { ...(binding ? { review_binding: binding } : {}) });
    }
  }
  if (!evidenceReview && !requiredVerdictsMet(policy, input.review)) return refused('semantic_review_failed', 'required calibrated review did not accept the draft');
  const workItem = plainObject(input.work_item) ? input.work_item : {};
  const context = plainObject(input.context) ? { ...input.context } : {};
  if (evidenceReview) context.evidence_provenance = evidenceProvenanceForDelivery(input.evidence_packet, evidenceReview.binding);
  if (recipe.delivery_target === undefined) return { passed: true, delivery: null, ...(evidenceReview ? { evidence_review: { binding: evidenceReview.binding, assurance: evidenceReview.review_assurance, rights: evidenceReview.rights_assurance } } : {}), ...(judged?.findings.length ? { findings: judged.findings } : {}) };
  if (evidenceReview && (recipe.delivery_target?.input?.evidence_provenance?.from !== 'context'
    || recipe.delivery_target?.input?.evidence_provenance?.field !== 'evidence_provenance')) {
    return refused('evidence_provenance_handoff_missing', 'strict evidence delivery must carry rights/provenance metadata to the named owner as evidence_provenance');
  }
  const [delivered, delivery, deliveryError] = buildOwnerDelivery(input.writing, workItem, context, recipe.delivery_target);
  if (!delivered) return refused('invalid_delivery_target', deliveryError);
  return { passed: true, delivery, ...(evidenceReview ? { evidence_review: { binding: evidenceReview.binding, assurance: evidenceReview.review_assurance, rights: evidenceReview.rights_assurance } } : {}), ...(judged?.findings.length ? { findings: judged.findings } : {}) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: checkWritingAgainstItsRecipe(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
