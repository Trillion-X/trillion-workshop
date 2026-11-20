// tools/composio-connection/read-data/composio-call.mjs
//
// Purpose: the one Composio connection kind every tool row can use. A person's accounts that Composio holds (Gmail, Google
// Calendar, Drive and the other toolkits Composio connects) are reached by one execute request: POST to the execute route of
// the toolkit tool, with the account's id and the tool's arguments, and the Composio API key in the x-api-key header. The
// key is held in the vault as `composio-api-key` (scoped to backend.composio.dev) and the run mounts it on descriptor 4. A
// tool row names this connection kind in its by_input variant (its credential mount and its connection), and each provider
// row names the Composio tool it runs: nothing here names a toolkit, a tool or a provider.
//
// Non-Negotiable Invariants:
// 1. The key is read from descriptor 4 only when a request needs it, kept in this run's memory, and sent only in the
//    x-api-key header of a request to the Composio host, over https, never followed by a redirect.
// 2. The request is one POST to /tools/execute/<TOOL_SLUG> with { connected_account_id, arguments }; the reply is its
//    `data`. A reply that Composio marks unsuccessful is refused with its own words, never read as an answer.
// 3. A tool slug that is not an upper-case slug, or an account id that is not text, is refused before any request leaves.

import { readFileSync } from 'node:fs';

const HELD_DESCRIPTOR = 4;
const SAID = 300;
const HOST = 'backend.composio.dev';
const EXECUTE = `https://${HOST}/api/v3/tools/execute/`;

export class Refused extends Error {}

/** `execute(tool, accountId, args)`: one Composio tool run for one connected account, as the person; resolves to the tool's data. */
export function makeComposioCall({ read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = {}) {
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused('The Composio key is not held: add composio-api-key to the vault, then run again.');
    return key;
  };
  return async function execute(tool, accountId, args = {}) {
    if (typeof tool !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(tool)) throw new Refused(`A Composio tool is named by its upper-case slug, not ${JSON.stringify(tool)}.`);
    if (typeof accountId !== 'string' || !accountId) throw new Refused('Give the Composio account id of the connection (its connection_id).');
    const url = new URL(EXECUTE + tool);
    if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Refused(`A Composio key goes only to ${HOST}, so nothing was sent to ${url.hostname}.`);
    const reply = await send(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-api-key': held(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected_account_id: accountId, arguments: args }),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Refused(`Composio refused ${tool} (${reply.status}): ${text.replace(/\s+/g, ' ').trim().slice(0, SAID)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Refused(`Composio answered ${tool} with no JSON.`); }
    if (parsed?.successful === false || parsed?.error) throw new Refused(`Composio could not run ${tool}: ${String(parsed.error ?? 'unsuccessful').slice(0, SAID)}`);
    return parsed?.data ?? null;
  };
}
