// tools/composio-connection/read-data/composio-accounts.mjs
//
// Purpose: the list of the connected accounts that Composio holds for the vault's key: each account's id, the user id that
// owns it (the entity a tool run names as user_id), its toolkit, alias and status. Read-only: one GET to the accounts list;
// nothing is created, changed or removed. Every Composio tool finds the owning user id of an account here, not by a guess.
//
// Non-Negotiable Invariants:
// 1. The key is read from descriptor 4 only, when a request needs it, and sent only in its auth headers (makeKeyHeaders) of a request to
//    the Composio host, over https, never followed by a redirect (the same rule as composio-call.mjs).
// 2. A reply Composio refuses is refused with its own words; an answer that is not JSON is refused, never read as an empty list.
// 3. A toolkit name that is not a lower-case slug is refused before any request leaves.
// 4. No answer or error carries the key.

import { readFileSync } from 'node:fs';
import { makeKeyHeaders } from './composio-call.mjs';

const HELD_DESCRIPTOR = 4;
const SAID = 300;
const HOST = 'backend.composio.dev';
const LIST = `https://${HOST}/api/v3/connected_accounts`;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export class Refused extends Error {}

/** One account, in the shape a tool run reads: its id, its owning user id, its toolkit, alias and status. */
export function accountOf(item) {
  return {
    id: String(item?.id ?? ''),
    user_id: item?.user_id ?? null,
    toolkit: item?.toolkit?.slug ?? null,
    alias: item?.alias ?? null,
    status: item?.status ?? null,
  };
}

/** `listAccounts({ toolkit })`: the connected accounts the key can see (of one toolkit when named), as accountOf rows. */
export function makeComposioAccounts({ read = descriptor => readFileSync(descriptor, 'utf8'), send = fetch } = {}) {
  const headersOf = makeKeyHeaders(send);
  let key = null;
  const held = () => {
    if (key === null) key = String(read(HELD_DESCRIPTOR)).trim();
    if (!key) throw new Refused('The Composio key is not held: add composio-api-key to the vault, then run again.');
    return key;
  };
  return async function listAccounts({ toolkit, projectId } = {}) {
    if (toolkit !== undefined && (typeof toolkit !== 'string' || !/^[a-z0-9_-]+$/.test(toolkit))) throw new Refused(`A toolkit is named by its lower-case slug, not ${JSON.stringify(toolkit)}.`);
    const accounts = [];
    let cursor = null;
    // Composio answers one page at a time, with next_cursor set while more accounts follow; every page is read to the end.
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(LIST);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (toolkit) url.searchParams.set('toolkit_slugs', toolkit);
      if (cursor) url.searchParams.set('cursor', cursor);
      if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Refused(`A Composio key goes only to ${HOST}, so nothing was sent to ${url.hostname}.`);
      const reply = await send(url, { method: 'GET', redirect: 'manual', headers: { ...await headersOf(held(), projectId), Accept: 'application/json' } });
      const text = await reply.text();
      if (!reply.ok) throw new Refused(`Composio refused the account list (${reply.status}): ${text.replace(/\s+/g, ' ').trim().slice(0, SAID)}`);
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Refused('Composio answered the account list with no JSON.'); }
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
      if (!items) throw new Refused('Composio answered the account list without its items.');
      accounts.push(...items.map(accountOf));
      cursor = Array.isArray(parsed) ? null : (parsed.next_cursor || null);
      if (!cursor) return accounts;
    }
    throw new Refused(`The account list has more than ${MAX_PAGES} pages; nothing is read past that, so the list is not complete.`);
  };
}
