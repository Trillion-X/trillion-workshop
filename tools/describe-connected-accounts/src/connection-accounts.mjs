// src/connection-accounts.mjs
//
// Purpose
//   Two facts about a person's connected accounts that the Connections screen shows (src/account-screens.mjs
//   connectionsFacts): which account of a service is the primary one, and what an account's sign-in allowed in plain
//   groups (Calendar, Contacts, Email...). The words, the minimum number of accounts and the groups are DATA
//   (src/connection-accounts.json); the choice is kept as one account fact by the person's store
//   (src/person-store.mjs setPrimaryConnection).
//
// Non-negotiable invariants
//   1. A choice names an account the person owns and that is still connected; a choice that no longer holds is
//      ignored, never shown, so the tag is never on an account that is gone.
//   2. A service with one account has no primary; one with several and no choice made uses its earliest connected one.
//   3. The groups say only what the provider reported (grant_scopes); an account whose permissions are unknown, or
//      that allowed none of the groups, shows no groups, never a row of "not allowed".
//
import settings from './connection-accounts.json' with { type: 'json' };

export const CONNECTION_ACCOUNTS = settings;
export const PRIMARY_FACT = settings.primary.fact;

const owned = item => item && !item.carried_by && item.visibility !== 'shared' && item.status === 'connected' && typeof item.connection_id === 'string';

/** The primary account of each service that has several: { [vendor]: connection_id }. `chosen` is the kept fact. */
export function primaryAccounts(connections, chosen = {}) {
  const byVendor = new Map();
  for (const item of connections.filter(owned)) byVendor.set(item.vendor, [...(byVendor.get(item.vendor) ?? []), item]);
  const primary = {};
  for (const [vendor, accounts] of byVendor) {
    if (accounts.length < settings.primary.min_accounts) continue;
    const kept = accounts.find(item => item.connection_id === chosen?.[vendor]);
    const earliest = [...accounts].sort((a, b) => String(a.connected_at ?? '').localeCompare(String(b.connected_at ?? '')))[0];
    primary[vendor] = (kept ?? earliest).connection_id;
  }
  return primary;
}

/** The kept choice with `connectionId` made the primary of its service, or null when it is not an account to choose. */
export function withPrimary(connections, chosen, connectionId) {
  const account = connections.find(item => owned(item) && item.connection_id === connectionId);
  return account ? { account, chosen: { ...(chosen ?? {}), [account.vendor]: account.connection_id } } : null;
}

/** The groups an account's sign-in allowed: [{ label, allowed }], or [] when it reported nothing or allowed none. */
export function scopeGroupsOf(item) {
  if (item?.grant_scopes_known !== true || !Array.isArray(item.grant_scopes)) return [];
  const scopes = item.grant_scopes.filter(scope => typeof scope === 'string');
  const groups = settings.scope_groups.groups.map(group => ({ label: group.label, allowed: group.pieces.some(piece => scopes.some(scope => scope.includes(piece))) }));
  return groups.some(group => group.allowed) ? groups : [];
}
