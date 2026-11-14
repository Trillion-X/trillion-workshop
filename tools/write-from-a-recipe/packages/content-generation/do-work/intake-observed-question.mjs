/** Current-owner intake. It never creates a review, queued work, or published page. */
import { prepareObservedQuestion } from './prepare-observed-question.mjs';

async function find(requests, session, kind, field, value) {
  const found = await requests.findCurrentItems(session, 'published-record',
    { all: [{ field: 'kind', eq: kind }, { field, eq: value }] }, { limit: 512 });
  if (!Array.isArray(found) || found.length >= 512) throw new Error('Current record read is incomplete.');
  return found.map((item) => item?.payload ?? item).filter(Boolean);
}
function one(items, label) {
  if (items.length !== 1) throw new Error(`Expected one current ${label}; found ${items.length}.`);
  return items[0];
}

export async function intakeObservedQuestion({ requests, session, sourceAtomRef, routeId, question }) {
  if (!requests || !session || !sourceAtomRef || !routeId) throw new Error('Selected app and exact source route are required.');
  const observations = await find(requests, session, 'observed-content.content-atom', 'atom_ref', sourceAtomRef);
  const routes = await find(requests, session, 'content-generation.question-source-route', 'id', routeId);
  if (observations.length === 0) return { accepted: false, reason: 'source_observation_not_found' };
  if (routes.length === 0) return { accepted: false, reason: 'question_source_route_not_found' };
  const observation = one(observations, 'observation');
  const route = one(routes, 'source route');
  const decision = prepareObservedQuestion({ observation, route, question });
  if (!decision.accepted) return decision;
  const existing = await find(requests, session, 'content-generation.question-candidate', 'id', decision.candidate.id);
  if (existing.length) return { accepted: false, reason: 'candidate_already_exists', candidate: existing[0] };
  const reply = await requests.writeRecords(session, decision.writes);
  if (!reply) throw new Error('Create-only intake write did not complete.');
  const [evidence, candidate] = await Promise.all([
    find(requests, session, 'content-generation.question-evidence', 'id', decision.evidence.id),
    find(requests, session, 'content-generation.question-candidate', 'id', decision.candidate.id),
  ]);
  if (one(evidence, 'evidence').revision !== decision.evidence.revision
    || one(candidate, 'candidate').revision !== decision.candidate.revision) {
    throw new Error('Question intake did not read back at the observed revision.');
  }
  return { accepted: true, evidence: evidence[0], candidate: candidate[0] };
}
