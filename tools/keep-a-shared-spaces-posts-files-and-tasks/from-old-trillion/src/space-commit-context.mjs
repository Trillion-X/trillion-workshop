// Native resource host supply: successful rule evaluations capture local policy
// preconditions. Every later SQL mutation checks them in the same synchronous
// turn as the write. Async invocation contexts never share captured authority.
import { AsyncLocalStorage } from 'node:async_hooks';
import { contentInvocationActive, ensureContentPolicyCurrentIfActive, isContentPolicyInternal } from './space-content-policy.mjs';
const commands = new AsyncLocalStorage();
const writes = /^\s*(?:insert|update|delete|replace|alter|drop|create|vacuum|reindex)\b/i;
// Only the mutation target owns the write. Derived cache statements and trigger
// definitions may read policy tables without changing their authoritative rows.
const contentPolicyMutation = /^\s*(?:(?:insert|replace)(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?|delete\s+from|(?:alter|drop|create)\s+table(?:\s+if\s+(?:not\s+)?exists)?)\s+["`\[]?(?:memberships|members|communities|space_rules|space_member_types|space_show_rule_types|space_tool_grants|relay_holds)\b/i;
export function withSpaceCommitContext(owner, invoke) {
  if (commands.getStore()?.owner === owner) return invoke();
  return commands.run({ owner, grants: new Map() }, invoke);
}
export function captureSpaceCommit(owner, { spaceId, relay, thing, state, deadline }) {
  const command = commands.getStore();
  if (!command || command.owner !== owner) return;
  const key = JSON.stringify([spaceId, relay, thing ?? null]);
  command.grants.set(key, { spaceId, relay, thing, state, deadline });
}
const assertCurrent = (owner, command) => {
  for (const grant of command.grants.values()) {
    if (Date.now() >= grant.deadline || grant.state !== owner.spaceAccessState(grant.spaceId, grant.relay, grant.thing)) throw new Error('Space permissions changed before commitment. Try again.');
  }
};
export function guardSpaceSql(owner, sql) {
  return { exec(query, ...binds) {
    const command = commands.getStore();
    const mutation = writes.test(query);
    const internalPolicy = isContentPolicyInternal(owner);
    if (mutation && owner.contentPolicyTarget && !internalPolicy && contentPolicyMutation.test(query)) {
      throw new Error('Space policy is read-only on this content owner.');
    }
    if (mutation && contentInvocationActive(owner)) ensureContentPolicyCurrentIfActive(owner);
    const guarded = command?.owner === owner && command.grants.size && writes.test(query);
    if (guarded) assertCurrent(owner, command);
    const result = sql.exec(query, ...binds);
    if (guarded) {
      // Only this already-authorized synchronous mutation can advance its own
      // captured precondition; changes during awaits never reach this branch.
      for (const grant of command.grants.values()) grant.state = owner.spaceAccessState(grant.spaceId, grant.relay, grant.thing);
    }
    return result;
  }, [Symbol.iterator]: sql[Symbol.iterator]?.bind(sql) };
}
