// src/local-choice-route.mjs
//
// Purpose: the account's choice routes, one copy for every store that answers them: choosing among supplied options
//   with the person's own local model (POST /local-choices/choose), reading how those choices went
//   (/local-choices/coverage), and scoring candidates by meaning (POST /score). PersonStore and the account's own records
//   resource (src/native-local-choices.mjs) both answer through this file.
//
// Non-Negotiable Invariants:
//   1. Choosing and the coverage read are private: a sign-in without the private reach is refused (403), as always.
//   2. Every scoring call goes through the observed choice contract (src/local-choice-observations.mjs) under the
//      candidate-scoring task's deadline, so it is counted in the coverage read and never waits past that deadline.
//   3. The scorer's vectors are kept in the answering store's own SQLite (vectorCache); nothing is shared across accounts.
//
//   observedScorer({ embed, sql, observations }) -> { score(input, row) }
//   isLocalChoicePath(pathname) -> boolean
//   handleLocalChoiceRequest({ privateReach, ask, observations, scorer }, request) -> Response
//     observations and scorer are functions returning the owner, so a request builds only what it uses.
import localChoiceTasks from '../../choose-locally/src/local-choice-tasks.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with { type: 'json' };
import { chooseLocal } from './local-choice.mjs';
import { handleScoreRequest, isScorePath, makeScorer, vectorCache } from '../../pick-the-best-of-a-known-set-of-choices-by-how/src/score-candidates.mjs';

const CHOOSE = '/local-choices/choose', COVERAGE = '/local-choices/coverage';

/** The scorer every candidate-scoring caller uses: the vector scorer, observed under the task's deadline. */
export function observedScorer({ embed, sql, cache, observations }) {
  const underlying = makeScorer({ embed, cache: cache ?? vectorCache(sql, settings.candidate_scorer.kept_vectors) });
  const deadline_ms = localChoiceTasks.tasks.find(task => task.id === 'candidate-scoring').deadline_ms;
  return { score: async (input, row) => {
    const answer = await observations.run({ task: 'candidate-scoring', surface: 'worker-score', model: row.model.id, deadline_ms,
      decide: () => underlying.score(input, row) });
    if (!answer) throw new Error('Candidate scoring did not answer before its deadline.');
    return answer;
  } };
}

export const isLocalChoicePath = pathname => pathname === CHOOSE || pathname === COVERAGE || isScorePath(pathname);

export async function handleLocalChoiceRequest({ privateReach, ask, observations, scorer }, request) {
  const path = new URL(request.url).pathname;
  if (path === CHOOSE) {
    if (!privateReach) return Response.json({ error: 'Local choices are private.' }, { status: 403 });
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    try {
      const answer = await chooseLocal(await request.json(), { ask, observations: observations() });
      return Response.json(answer ?? { choice: null, unavailable: true, reason: 'The local model did not answer in time.' });
    } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  if (path === COVERAGE) {
    if (!privateReach) return Response.json({ error: 'Choice coverage is private.' }, { status: 403 });
    if (request.method !== 'POST' && request.method !== 'GET') return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ ...observations().summary(), tasks: localChoiceTasks.tasks });
  }
  if (isScorePath(path)) return handleScoreRequest(scorer(), settings.candidate_scorer, request);
  return Response.json({ error: 'Not found' }, { status: 404 });
}
