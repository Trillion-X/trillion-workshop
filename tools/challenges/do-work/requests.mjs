// tools/challenges/do-work/requests.mjs
//
// The functions the rows in tool-rows.json run (one per row, through run-request.mjs). Each takes the request a
// person's AI gives and answers with plain JSON; a request that cannot be run throws a sentence saying what to fix.
import { decideEnrollments, validateChallengeDefinition } from '../read-data/challenges.mjs';

const isText = value => typeof value === 'string' && value.trim().length > 0;

export function checkChallengeDefinitions(request) {
  if (!Array.isArray(request.definitions)) throw new Error('definitions must be a list of challenge definitions.');
  return {
    results: request.definitions.map(definition => ({ id: isText(definition?.id) ? definition.id : '', ...validateChallengeDefinition(definition) })),
  };
}

export function enrollInChallenges(request) {
  if (!Array.isArray(request.definitions)) throw new Error('definitions must be a list of challenge definitions.');
  if (!request.scores || typeof request.scores !== 'object' || Array.isArray(request.scores)) {
    throw new Error('scores must map each challenge id to the observer\'s score for it (a number).');
  }
  for (const field of ['observer_id', 'started_at', 'status_key']) {
    if (!isText(request[field])) throw new Error(`${field} must be given as text: the tool holds no clock and no status words of its own.`);
  }
  if (Number.isNaN(Date.parse(request.started_at))) throw new Error('started_at must be a date and time such as 2026-01-01T09:00:00Z.');
  return decideEnrollments({
    definitions: request.definitions,
    scores: request.scores,
    observerId: request.observer_id,
    startedAt: request.started_at,
    statusKey: request.status_key,
  });
}
