const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const principal = value => typeof value === 'string' && value.trim().length > 0;

// Policy belongs to the account's recipe. Identity comes only from the host, never the output being checked.
export function actorPolicyProblems(policy, { name, step_id, asks, prior }) {
  if (policy === undefined) return [];
  const problems = [];
  if (!object(policy) || policy.authenticated !== true || Object.keys(policy).some(key => !['authenticated', 'distinct_from', 'distinct_from_if_admitted'].includes(key)))
    return [`${name}.actor_policy must require authenticated: true with distinct_from or distinct_from_if_admitted prior step ids.`];
  const own = asks.get(step_id);
  if (!(own?.name === 'ai' || own?.name?.startsWith('agent:'))) problems.push(`${name}.actor_policy requires an AI or agent ask.`);
  for (const field of ['distinct_from', 'distinct_from_if_admitted']) {
    const refs = policy[field] ?? [];
    if (!Array.isArray(refs) || refs.length > 64 || refs.some(id => typeof id !== 'string') || new Set(refs).size !== refs.length)
      problems.push(`${name}.actor_policy.${field} must list at most 64 different prior step ids.`);
  }
  if (problems.some(problem => problem.includes('must list'))) return problems;
  const refs = [...(policy.distinct_from ?? []), ...(policy.distinct_from_if_admitted ?? [])];
  for (const id of refs) {
    if (id === step_id || !prior(id)) problems.push(`${name}.actor_policy.distinct_from names ${id}, which is not a prior dependency.`);
    if (asks.get(id)?.policy?.authenticated !== true) problems.push(`${name}.actor_policy.distinct_from requires authenticated actor evidence on ${id}.`);
  }
  return problems;
}

export function handoffActorEvidence(handoff) {
  if (handoff?.state !== 'finished' || handoff.withdrawal || handoff.result?.state === 'withdrawn') return null;
  const attempt = [...(handoff.attempts ?? [])].reverse().find(row => row.generation === handoff.generation);
  if (!principal(attempt?.claim_reader) || attempt.agent_id !== handoff.taken_by) return null;
  return { principal: attempt.claim_reader, via: 'handoff', handoff_id: handoff.handoff_id, agent_id: handoff.taken_by, generation: handoff.generation };
}

export function submittedActorEvidence(reader) {
  return principal(reader) ? { principal: reader, via: 'submit' } : null;
}

export function actorAdmissionProblems(policy, evidence, prior, admitted = id => prior(id) !== undefined) {
  if (!policy) return [];
  if (!principal(evidence?.principal)) return ['This step requires authenticated actor evidence from its actual author.'];
  const problems = [];
  const refs = new Set([...(policy.distinct_from ?? []), ...(policy.distinct_from_if_admitted ?? []).filter(admitted)]);
  for (const id of refs) {
    const earlier = prior(id);
    if (!principal(earlier?.principal)) problems.push(`Step ${id} has no admitted authenticated actor evidence.`);
    else if (earlier.principal === evidence.principal) problems.push(`This step requires a different authenticated actor from step ${id}.`);
  }
  return problems;
}
