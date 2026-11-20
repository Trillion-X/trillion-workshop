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

/** The headers a held key is sent with: a project key (ak_) as x-api-key; a person's own user key (uak_) as x-user-api-key, with
 *  the project their connections live in (a person's own connections sit in their consumer project, which only a user key with
 *  that project named can reach). */
export function keyHeaders(key, projectId) {
  if (!key.startsWith('uak_')) return { 'x-api-key': key };
  if (typeof projectId !== 'string' || !/^pr_[A-Za-z0-9_-]+$/.test(projectId)) throw new Refused('A user key reaches connections only with the project they live in: give project_id (pr_...).');
  return { 'x-user-api-key': key, 'x-project-id': projectId };
}

/** `execute(tool, accountId, args, userId)`: one Composio tool run for one connected account, as the person; resolves to the tool's
 *  data. Composio needs the user id that owns the account (its entity) with a connected account, so a run passes it when given. */
export function makeComposioCall({ read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = {}) {
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused('The Composio key is not held: add composio-api-key to the vault, then run again.');
    return key;
  };
  return async function execute(tool, accountId, args = {}, userId = undefined, projectId = undefined) {
    if (typeof tool !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(tool)) throw new Refused(`A Composio tool is named by its upper-case slug, not ${JSON.stringify(tool)}.`);
    if (typeof accountId !== 'string' || !accountId) throw new Refused('Give the Composio account id of the connection (its connection_id).');
    const url = new URL(EXECUTE + tool);
    if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Refused(`A Composio key goes only to ${HOST}, so nothing was sent to ${url.hostname}.`);
    const reply = await send(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...keyHeaders(held(), projectId), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected_account_id: accountId, ...(userId ? { user_id: userId } : {}), arguments: args }),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Refused(`Composio refused ${tool} (${reply.status}): ${text.replace(/\s+/g, ' ').trim().slice(0, SAID)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Refused(`Composio answered ${tool} with no JSON.`); }
    if (parsed?.successful === false || parsed?.error) throw new Refused(`Composio could not run ${tool}: ${String(parsed.error ?? 'unsuccessful').slice(0, SAID)}`);
    return parsed?.data ?? null;
  };
}

const PROXY = `https://${HOST}/api/v3/tools/execute/proxy`;

/** `proxy({endpoint, method, body, parameters}, accountId)`: one request to the connected app's own API, sent by Composio with the
 *  account's held sign-in, for a field Composio's named tools do not carry (for example a post's trial settings). The endpoint is
 *  the app's own path or address; Composio adds the account's credentials. Resolves to the app's answer. */
export function makeComposioProxy({ read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = {}) {
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused('The Composio key is not held: add composio-api-key to the vault, then run again.');
    return key;
  };
  return async function proxy(request, accountId, userId = undefined, projectId = undefined) {
    const { endpoint, method = 'GET', body, parameters } = request ?? {};
    if (typeof endpoint !== 'string' || !endpoint) throw new Refused('Give the app endpoint the request goes to (its path or address).');
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) throw new Refused(`A request's method is GET, POST, PUT, PATCH or DELETE, not ${JSON.stringify(method)}.`);
    if (typeof accountId !== 'string' || !accountId) throw new Refused('Give the Composio account id of the connection (its connection_id).');
    if (parameters !== undefined && !Array.isArray(parameters)) throw new Refused('parameters is a list of {name, value, in: "query" or "header"}.');
    const reply = await send(new URL(PROXY), {
      method: 'POST',
      redirect: 'manual',
      headers: { ...keyHeaders(held(), projectId), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, method, connected_account_id: accountId, ...(userId ? { user_id: userId } : {}), ...(body !== undefined ? { body } : {}), ...(parameters ? { parameters } : {}) }),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Refused(`Composio refused the ${method} to ${endpoint} (${reply.status}): ${text.replace(/\s+/g, ' ').trim().slice(0, SAID)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Refused(`Composio answered the ${method} to ${endpoint} with no JSON.`); }
    if (parsed?.successful === false || parsed?.error) throw new Refused(`The ${method} to ${endpoint} did not go through: ${JSON.stringify(parsed.error ?? parsed.data ?? 'unsuccessful').slice(0, SAID)}`);
    return { status: parsed?.status ?? null, data: parsed?.data ?? null };
  };
}
