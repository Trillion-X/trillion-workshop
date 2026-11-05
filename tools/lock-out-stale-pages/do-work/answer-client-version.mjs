// tools/lock-out-stale-pages/do-work/answer-client-version.mjs
//
// GET /work/api/client-version, answered as old trillion's Worker answered it (src/worker.mjs lines 1002-1003 at tag
// old-trillion-before-worker-retire): which page builds may keep working, from the DATA this folder carries
// (src/client-version.json through src/client-version.mjs clientVersionAnswer). Nothing is read from the person's
// records, so the run is handed no records door. The engine runs this as a @workshop-routes tool: input
// { path, method, query, body, browser }, result { status, body }.
//
//   GET /client-version   -> 200 { minimum_generation, lock_out_before }
//   anything else         -> 404 { error: 'Not found' }   (the Worker's answer to a route it does not own)
import { clientVersionAnswer } from '../src/client-version.mjs';

const json = (body, status = 200) => ({ status, body });

/** The page route { path, method } -> { status, body }. */
export function answerClientVersion({ path, method = 'GET' } = {}) {
  const request = { method: String(method).toUpperCase() };
  const url = { pathname: `/work/api${String(path ?? '').split('?')[0]}` };
  // Which page builds may keep working (src/client-version.mjs): the Worker's own DATA, no store request.
  if (request.method === 'GET' && url.pathname === '/work/api/client-version') return json(clientVersionAnswer());
  return json({ error: 'Not found' }, 404);
}
