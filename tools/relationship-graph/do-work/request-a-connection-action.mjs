// tools/relationship-graph/do-work/request-a-connection-action.mjs
//
// Prepares the request an action on a connection asks for (request-connection-action.ts: the action's target, and its
// input read through the action's input_mapping) and keeps it as a `connection-action-request` record through the
// records door, where whatever owns the target picks it up. An action with no id or no target is answered as
// unavailable and nothing is kept. Run by the Workshop tool `tool:request-a-connection-action` through
// tools/records-door/do-work/run-an-export.mjs.
import { randomUUID } from 'node:crypto';
import { prepareConnectionActionRequest } from './request-connection-action.ts';

export const REQUEST_KIND = 'connection-action-request';

export async function requestAConnectionAction(input, { door }) {
  if (!input?.action || typeof input.action !== 'object') throw new Error('give action: the action to request, with its id and target');
  const prepared = prepareConnectionActionRequest({ action: input.action, input: input.input ?? {}, correlation_id: input.correlation_id });
  if (!prepared.available) return prepared;
  const request_id = `${REQUEST_KIND}:${input.correlation_id ?? randomUUID()}`;
  await door.write([{ id: request_id, type: REQUEST_KIND, value: { target: prepared.target, payload: prepared.payload } }]);
  return { ...prepared, request_id };
}
