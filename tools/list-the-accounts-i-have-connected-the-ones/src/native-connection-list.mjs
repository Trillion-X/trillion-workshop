// src/native-connection-list.mjs
//
// PURPOSE
//   The account's connected accounts as list_connections and the Connections screen read them (GET /connections),
//   answered in the account's own records resource: the accounts it keeps sign-ins for, then the ones its computers
//   carry, a page at a time; one account by connection_id or record_ref; and the accounts others shared with it
//   (visibility shared), each with its related records when asked.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A read creates nothing: no credential, no network identity (shared accounts are read only when the account
//      already has a relay), no duplicate record.
//   2. Rows are the connection-records projections (src/connection-records.mjs); no held value ever leaves.
//   3. A missing relationship page is unknown, never a reason to fail the list.
//   4. Owned and shared identities never cross: a shared account is named by its record_ref, never a connection_id.

import { clampSharedConnectionLimit, connectionIdFromRecord, connectionRelations, ownedConnectionRow, sharedConnectionOfferId, sharedConnectionPage, sharedConnectionRow } from '../../find-and-keep-my-connections/src/connection-records.mjs';
import { recordModelLabels } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model-tools.mjs';

const refused = message => Object.assign(new Error(message), { status: 400 });

/** One row with the records related to it; an unreadable relationship page is unknown, never a failure. */
export const connectionRowRelations = records => row => {
  try {
    const links = connectionRelations(records, row.record_ref);
    const labels = recordModelLabels(records, links.related.map(item => item.record));
    return { ...row, related: links.related.map(item => ({ ...item, title: labels[item.record]?.title ?? item.record })), relations_complete: links.complete };
  } catch { return { ...row, related: [], relations_complete: false }; }
};

/** Kept sign-ins first (held: the held-values executor), then carried ones, with cursors stored:<n> and carried:<n>. */
export const connectionsPage = ({ held, carried }) => async ({ after, next, limit = 100 } = {}) => {
  after = after ?? next ?? '';
  const size = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Math.floor(Number(limit)))) : 100;
  if (typeof after !== 'string' || after.length > 2200) throw refused('after must be the next value of a connections page.');
  if (!after.startsWith('carried:')) {
    const cursor = after.startsWith('stored:') ? after.slice(7) : after;
    const kept = await held({ invocation: { operation: 'list_page' }, input: { after: cursor, limit: size } });
    if (kept.next !== null) return { connections: kept.connections, next_after: `stored:${kept.next}`, next: `stored:${kept.next}` };
    const rows = await carried();
    const room = size - kept.connections.length;
    return { connections: [...kept.connections, ...rows.slice(0, room)], next_after: rows.length > room ? `carried:${room}` : null, next: rows.length > room ? `carried:${room}` : null };
  }
  const offset = Number(after.slice(8));
  if (!Number.isSafeInteger(offset) || offset < 0) throw refused('after must be the next value of a connections page.');
  const rows = await carried();
  return { connections: rows.slice(offset, offset + size), next_after: rows.length > offset + size ? `carried:${offset + size}` : null, next: rows.length > offset + size ? `carried:${offset + size}` : null };
};

/** The accounts others shared with this account, read through the network only when it already has a relay. */
export const sharedConnectionsPage = ({ network, relay, readShared, relations }) => async ({ after = '', limit = 30, include_related = true } = {}) => {
  if (typeof after !== 'string' || after.length > 1024) throw new TypeError('after must be a shared-account cursor.');
  const size = clampSharedConnectionLimit(limit);
  const own = relay();
  const offered = own ? await network().recordsOfferedPage({ relay: own, kind: 'connection', after, limit: size })
    : { shared_with_you: [], next_after: null, complete: true };
  // The Network cursor advances over scanned offers, including revoked or inaccessible rows; it is never
  // reinterpreted as a record id, and a page is never filled by reading later offers.
  const page = await sharedConnectionPage({ offers: offered.shared_with_you, read: id => readShared(id, { bounded: true }), limit: size });
  return { ...page, next: offered.next_after ?? null,
    coverage: { ...page.coverage, complete: offered.complete === true && page.coverage.complete },
    connections: include_related ? page.connections.map(relations) : page.connections };
};

/**
 * The route, over its owners:
 *   owner()                    the account as a connection owner (connection-records connectionOwner)
 *   page({ after, limit })     connectionsPage
 *   listed(connection_id)      one kept account, or null
 *   carried()                  the carried accounts
 *   relations(row)             connectionRowRelations
 *   sharedPage(input)          sharedConnectionsPage
 *   readShared(offer, options) one shared record
 * query is the request's search parameters as an object of strings.
 */
export function nativeConnectionList({ owner, page, listed, carried, relations, sharedPage, readShared }) {
  return async function list(query = {}) {
    const has = name => query[name] !== undefined && query[name] !== null;
    const after = query.after ?? query.next ?? '';
    const visibility = query.visibility ?? 'owned';
    const includeRelated = String(query.include_related) === 'true';
    if (!['owned', 'shared'].includes(visibility)) throw refused('visibility must be owned or shared.');
    if (visibility === 'shared') {
      if (has('connection_id')) throw refused('Shared accounts use their record_ref, not an owner-private connection_id.');
      if (has('record_ref')) {
        const offer = sharedConnectionOfferId(query.record_ref);
        if (!offer) throw refused('Use the shared account record_ref returned by list_connections.');
        let row = null;
        try { row = sharedConnectionRow(await readShared(offer, { bounded: true }), offer); } catch { /* no stale metadata on a revoked or unavailable share */ }
        return { connections: row ? [includeRelated ? relations(row) : row] : [], next_after: null, next: null,
          unavailable: row ? 0 : 1, coverage: { source: 'explicit_shares', complete: Boolean(row), other_accounts: 'unknown' } };
      }
      const found = await sharedPage({ after, limit: clampSharedConnectionLimit(query.limit ?? 30), include_related: includeRelated });
      return { ...found, next_after: found.next };
    }
    const mine = owner();
    const shown = row => {
      const value = ownedConnectionRow(row, mine);
      return value && (includeRelated ? relations(value) : value);
    };
    if (after.length > 2200 || (after.startsWith('carried:') && (!/^\d+$/.test(after.slice(8)) || !Number.isSafeInteger(Number(after.slice(8)))))) {
      throw refused('after must be the next value of a connections page.');
    }
    if (has('connection_id') || has('record_ref')) {
      const id = has('record_ref') ? connectionIdFromRecord(query.record_ref) : query.connection_id;
      if (!id) throw refused('Use the connection_id or record_ref returned by list_connections.');
      const row = await listed(id) ?? (await carried()).find(item => item.connection_id === id) ?? null;
      return { connections: row ? [shown(row)].filter(Boolean) : [], next_after: null, next: null };
    }
    const found = await page({ after, limit: Math.max(1, Math.min(100, Number(query.limit ?? 100))) });
    return { ...found, connections: found.connections.map(shown).filter(Boolean), next: found.next_after };
  };
}
