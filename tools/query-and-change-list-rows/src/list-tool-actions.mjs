// Every ordinary List MCP operation, available to an account-authored Marketplace tool.
// Derive the operations from the same declarations and call their supplied owner;
// do not duplicate List validation, managed configuration writes, views or side effects.
import { listTools } from './list-tools.mjs';
import { EXECUTION_HEADER } from './execution-context.mjs';

async function callListRoute(store, path, body, task) {
  const headers = new Headers({ 'x-trillion-app': 'Trillion' });
  // The Workshop owns this task and its authenticated source. Inputs cannot supply a
  // source header: the existing List mutation joins the actual run's source instead.
  if (typeof task?.execution_ref === 'string' && task.execution_ref) headers.set(EXECUTION_HEADER, task.execution_ref);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await store.fetch(new Request(`https://person${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? `The List action answered ${response.status}.`);
    error.status = response.status;
    if (result.code) error.code = result.code;
    if (result.next_call) error.next_call = result.next_call;
    throw error;
  }
  return result;
}

export const listToolRouteActions = call => Object.fromEntries(listTools(() => {}).map(({ name }) => [
  name.replaceAll('_', '-'),
  (input, _invocation, { task } = {}) => listTools((path, body) => call(path, body, task, name))
    .find(tool => tool.name === name).run(input ?? {}),
]));

export const listToolActions = store => listToolRouteActions((path, body, task) => callListRoute(store, path, body, task));
