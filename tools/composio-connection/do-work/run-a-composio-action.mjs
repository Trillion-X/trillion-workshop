#!/usr/bin/env node
// tools/composio-connection/do-work/run-a-composio-action.mjs
//
// PURPOSE: tool:run-a-composio-action, run in the tool container. Reads one request on stdin and runs it for one connected
// account with the vault's Composio key: either a Composio tool by its slug ({action, arguments}), or one request to the app's own
// API sent by Composio with the account's sign-in ({proxy: {endpoint, method, body?, parameters?}}) for a field Composio's tools
// do not carry. Nothing here names an app, a tool or an account: the caller's row or step names them. Refusals exit 1 with the
// words of whoever refused; the key appears in no answer, and a token the app writes into its own answer (a Graph paging link's
// access_token) is removed by keep-secrets-out-of-answers before the answer is handed back.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeComposioCall, makeComposioProxy, Refused } from '../read-data/composio-call.mjs';
import { stripSecrets } from '../../keep-secrets-out-of-answers/read-data/strip-secrets.mjs';

/** One action or one proxied request, answered as {account_id, action | endpoint, data[, status]}. */
export async function runAComposioAction(request = {}, { execute = makeComposioCall(), proxy = makeComposioProxy() } = {}) {
  const { action, arguments: args = {}, proxy: asked, account_id: accountId, user_id: userId, project_id: projectId } = request;
  if ((action === undefined) === (asked === undefined)) throw new Refused('Give either action (a Composio tool slug) or proxy (a request to the app), not both and not neither.');
  if (action !== undefined) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Refused('arguments is an object of the tool\'s own fields.');
    return { account_id: accountId ?? null, action, data: stripSecrets(await execute(action, accountId, args, userId, projectId)) };
  }
  const answer = await proxy(asked, accountId, userId, projectId);
  return { account_id: accountId, endpoint: asked.endpoint, status: answer.status, data: stripSecrets(answer.data) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAComposioAction(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
