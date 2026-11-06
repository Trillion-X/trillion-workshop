// tools/decide-with-a-method/read-data/decisions-route.mjs
//
// PURPOSE
//   The page route GET /work/api/decisions as a Workshop route tool (the engine's `@workshop-routes` family runs this
//   row for the page's account with { path, method, query, body, browser } and answers the page with the result's
//   { status, body }). Old trillion answered it with the Decisions screen's rows, `person.workScreen()`
//   (src/worker.mjs:1026, tag old-trillion-before-worker-retire), the read `tool:see-my-decisions` moved here
//   (read-data/work-screen.mjs seeMyDecisions, from src/native-work-screen.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The answer is the moved screen read's, unchanged: this file only hands it the page's request, as old trillion
//      called workScreen() with nothing from the request.
//   2. Only GET /decisions is this row's; any other path or method answers 404 { error: 'Not found' }, the answer old
//      trillion's page routes gave a path they had no row for.
//   3. The access and allowance are what the caller's computer reports (work-screen.mjs): a page route reports none, so
//      the screen reads as a plan with no limit, the way the native engine's account has no plan.
//
import { seeMyDecisions } from './work-screen.mjs';

/** tool:answer-the-decisions-route */
export async function answerDecisionsRoute(input = {}, { door } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (!(method === 'GET' && path === '/decisions')) return { status: 404, body: { error: 'Not found' } };
  return { status: 200, body: await seeMyDecisions({}, { door }) };
}
