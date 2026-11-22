#!/usr/bin/env node
import { realpathSync } from 'node:fs';
// tools/composio-connection/do-work/list-connected-accounts.mjs
//
// PURPOSE: tool:list-my-connected-accounts, run in the tool container. Reads the request on stdin ({ toolkit? }) and answers
// the connected accounts the vault's Composio key can see, each with the user id that owns it. Read-only (see
// read-data/composio-accounts.mjs). Refusals exit 1 with Composio's own words.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeComposioAccounts } from '../read-data/composio-accounts.mjs';

/** The accounts answer: the count and the accounts, with no key in it. */
export async function listConnectedAccounts(request = {}, { list } = {}) {
  // Counts the requests the list sends: one per Composio page read to the end.
  let pagesRead = 0;
  const reader = list ?? makeComposioAccounts({ send: (url, init) => { pagesRead += 1; return fetch(url, init); } });
  const accounts = await reader({ toolkit: request.toolkit, projectId: request.project_id });
  return { toolkit: request.toolkit ?? null, count: accounts.length, accounts, pages_read: pagesRead };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  listConnectedAccounts(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
