// Questions from an already anonymized, voluntarily shared decision. The opaque
// pool id points to that shared decision, never to its owner or private case id.
export function sharedQuestionCandidates(entry, sharedDecisionId) {
  if (!entry || !sharedDecisionId || !entry.situation || !entry.chosen) return [];
  const source = { shared_decision_id: sharedDecisionId, path: `/mcp/api/shared-decisions/${encodeURIComponent(sharedDecisionId)}` };
  const questions = [];
  if (entry.why) questions.push({
    question: `A similar decision was made because “${entry.why}”. Does that reason hold here, and what evidence would change the choice?`,
    source,
  });
  if (entry.measured_by) questions.push({
    question: `A similar decision checked success by “${entry.measured_by}”. What would show whether this choice worked here?`,
    source,
  });
  return questions;
}
