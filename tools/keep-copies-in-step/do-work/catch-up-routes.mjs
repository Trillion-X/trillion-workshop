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
//   1. The decisions are the moved code's (read-data/catch-up.mjs `here`): this file only reads the device rows,
//      hands them to it and writes back what it kept, through the run's records door.
//   2. The answer is the moved route's own (read-data/catch-up.mjs handleCatchUpRequest): a report answers 200
//      { device, written }, a refused report (CatchUpError) or a body that is not JSON 400 { error }; any other path
//      or method is 404 { error: 'Not found' }, as the old route answered a path it had no row for.
//   3. The write stands on what was read (`expected`). A device row changed meanwhile is read again and the report
//      decided again, at most `most_tries` times, so a report is never lost to another device's report.
//
import ROWS from '../read-data/copies-rows.json' with { type: 'json' };
import { catchUp, handleCatchUpRequest } from '../read-data/catch-up.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const CONFLICT = 'original_command_conflict';
const MOST_TRIES = 4;
const answer = (status, body) => ({ status, body });

/** The body as the page sent it, as text for the moved route: the engine hands JSON ({} when there was none). */
const textOf = body => (body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body));

async function here(body, door, now) {
  for (let tries = 1; ; tries += 1) {
    const held = await door.readRecord(ROWS.devices.type, ROWS.devices.id);
    const rows = object(held?.value) && Array.isArray(held.value.value) ? held.value.value : [];
    let kept = null;
    const store = { devices: () => kept ?? rows, putDevices: value => { kept = value; } };
    const reply = catchUp(store, { records: null, now }).here(body);
    if (!reply.written) return reply;
    const value = { ...(object(held?.value) ? held.value : {}), value: kept };
    const expected = held ? { type: ROWS.devices.type, value: held.value } : null;
    try {
      await door.write([{ id: ROWS.devices.id, type: ROWS.devices.type, value, expected }],
        { key: `catch-up-here:${reply.device.device_id}:${reply.device.seen_at}:${tries}` });
      return reply;
    } catch (error) {
      if (error?.code !== CONFLICT || tries >= MOST_TRIES) throw error;
    }
  }
}

/** tool:answer-the-catch-up-here-route: the request handed to the moved route (read-data/catch-up.mjs
 *  handleCatchUpRequest), over an owner whose report is kept through the door; only the report is this row's. */
export async function answerCatchUpRoute(input = {}, { door, now = () => Date.now() } = {}) {
  const path = String(input.path ?? '');
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!(method === 'POST' && path === '/catch-up/here')) return answer(404, { error: 'Not found' });
  const owner = { here: body => here(body, door, now) };
  const response = await handleCatchUpRequest(owner, new Request(`https://person${path}`, { method, body: textOf(input.body) }));
  return answer(response.status, await response.json());
}
