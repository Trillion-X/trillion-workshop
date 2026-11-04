// tools/describe-connected-accounts/do-work/describe-connected-accounts.mjs
//
// tool:describe-connected-accounts. The row's request ({ connections, chosen?, arriving?, local_copies?, capabilities? })
// handed to the moved owners: primaryAccounts and scopeGroupsOf (src/connection-accounts.mjs) and the card words
// (src/connection-card-words.mjs). Every fact comes from the request; nothing is read or kept.
import { primaryAccounts, scopeGroupsOf } from '../src/connection-accounts.mjs';
import { connectionCardFacts, connectionCardSteps, connectionCardWords } from '../src/connection-card-words.mjs';

export function describeConnectedAccounts({ connections, chosen = {}, arriving = {}, local_copies = [], capabilities = {} } = {}) {
  if (!Array.isArray(connections)) throw new Error('Give connections: [{ connection_id, vendor, service, account_label, status, connected_at, grant_scopes_known, grant_scopes, can_send }].');
  const primary = primaryAccounts(connections, chosen);
  return {
    primary,
    accounts: connections.map(item => {
      const words = connectionCardWords(connectionCardFacts(item, {
        arriving: arriving[item.vendor] ?? [], localCopy: local_copies.includes(item.connection_id), capabilities: capabilities[item.vendor] ?? [],
      }));
      return { connection_id: item.connection_id ?? null, primary: Boolean(item.connection_id) && primary[item.vendor] === item.connection_id, allowed_groups: scopeGroupsOf(item), words, steps: connectionCardSteps(words) };
    }),
  };
}
