// tools/keep-copies-in-step/do-work/catch-up-routes.mjs
//
// PURPOSE
//   The page route POST /work/api/catch-up/here as a Workshop route tool (the engine's `@workshop-routes` family runs
//   this row for the page's account with { path, method, query, body, browser } and answers the page with the result's
//   { status, body }). It answers exactly what old trillion answered for the same request: src/catch-up.mjs
//   handleCatchUpRequest over the person store's catch-up owner (src/person-store.mjs:8189, reached from
//   src/worker.mjs:1185), tag old-trillion-before-worker-retire.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's (read-data/catch-up.mjs `here`): this file only reads the device row from the
//      request's `stored.records` (the person's setting:catch_up_devices, handed in by the caller), hands it to them and
//      answers the row it made as `keep`.
//   2. The answer is the moved route's own (read-data/catch-up.mjs handleCatchUpRequest): a report answers 200
//      { device, written }, a refused report (CatchUpError) or a body that is not JSON 400 { error }; any other path
//      or method is 404 { error: 'Not found' }, as the old route answered a path it had no row for.
//   3. The kept row stands on what was read (`expected`: the row as it was handed in, or null when none was). The caller's
//      conditional write refuses it when the row changed meanwhile, and the caller runs the route again on the rows as
//      they are then, so a report is never lost to another device's report.
//
import ROWS from '../read-data/copies-rows.json' with { type: 'json' };
import { catchUp, handleCatchUpRequest } from '../read-data/catch-up.mjs';
import { nowOf } from './copies.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const answer = (status, body, keep = []) => ({ status, body, keep });

/** The body as the page sent it, as text for the moved route: the engine hands JSON ({} when there was none). */
const textOf = body => (body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body));

/** The device row as the caller handed it in: { id, type, value } or null when the request does not carry it. */
const deviceRowOf = input => (input.stored?.records ?? []).find(record => record.id === ROWS.devices.id && record.type === ROWS.devices.type) ?? null;

/** tool:answer-the-catch-up-here-route: the request handed to the moved route (read-data/catch-up.mjs
 *  handleCatchUpRequest), over the device row the request carries; the one row it changes comes back as `keep`. */
export async function answerCatchUpRoute(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const path = String(input.path ?? '');
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!(method === 'POST' && path === '/catch-up/here')) return answer(404, { error: 'Not found' });
  const held = deviceRowOf(input);
  const rows = object(held?.value) && Array.isArray(held.value.value) ? held.value.value : [];
  let kept = null;
  const store = { devices: () => kept ?? rows, putDevices: value => { kept = value; } };
  const now = nowOf(input);
  const owner = { here: body => catchUp(store, { records: null, now }).here(body) };
  const response = await handleCatchUpRequest(owner, new Request(`https://person${path}`, { method, body: textOf(input.body) }));
  const body = await response.json();
  if (response.status !== 200 || !body.written) return answer(response.status, body);
  const value = { ...(object(held?.value) ? held.value : {}), value: kept };
  const expected = held ? { type: ROWS.devices.type, value: held.value } : null;
  return answer(response.status, body, [{ id: ROWS.devices.id, type: ROWS.devices.type, value, expected }]);
}
