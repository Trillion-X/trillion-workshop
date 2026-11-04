// src/consequence-classes.mjs
//
// Purpose: one DATA table of what actions do to the world (a message sent, money moved, a public post, a deletion) and
// the one function every acting tool is checked through. Each class has a mode (none, confirm_now, handoff); every
// class is `none` unless the person or space turns it on, so nothing is gated by default.
//
// Non-negotiable invariants
//   1. The table is src/consequence-classes.json; no tool, service or class is named here. A class is found by the
//      tool's name or by its annotations, first row wins.
//   2. A scope is display-only: typed, bounded, sanitised words showing who receives it, how much, how public. It never
//      grants permission and never changes a decision. An over-bound field is cut, never rejected.
//   3. When a class is switched on, the person's yes is bound to the scope's identity (BLAKE3 over the exact input
//      shown): an approval for other input, or one past its end time, does not count, and the refusal shows the scope.
//   4. Enforced where tools are called (src/tools.mjs handleMcpMessage `consequences`), not in model instructions.
import table from './consequence-classes.json' with { type: 'json' };
import { identityOf } from '../../shared-code/src/typed-operation-contract.mjs';
import { cleanLabel } from '../../shared-code/src/quoted-words.mjs';

const first = (input, keys = []) => keys.map(key => input?.[key]).find(value => value !== undefined && value !== null && value !== '');
const bounded = (value, limit) => cleanLabel(typeof value === 'object' ? JSON.stringify(value) : value, limit);

/** The class row for a tool: { id, label, mode, scope } or null when no row describes it. */
export function classOf(tool, rows = table.classes) {
  const hints = tool?.annotations ?? {};
  return rows.find(row => row.tools?.includes(tool?.name) || (row.annotations && Object.entries(row.annotations).every(([key, wanted]) => hints[key] === wanted))) ?? null;
}

/** The display-only scope of this call under its class, bounded as the table says. */
export function scopeOf(row, input, bounds = table.bounds) {
  const scope = row.scope ?? {};
  const target = first(input, scope.target);
  const recipients = (scope.recipients ?? []).map(key => input?.[key]).find(Array.isArray);
  const amount = first(input, scope.amount);
  return {
    kind: scope.kind ?? row.id,
    ...(target !== undefined ? { target: bounded(target, bounds.target) } : {}),
    ...(Array.isArray(recipients) ? { recipient_count: recipients.length, recipients: recipients.slice(0, bounds.recipients_shown).map(item => bounded(item, bounds.recipient_preview)) } : {}),
    ...(amount !== undefined ? { amount: bounded(amount, bounds.amount) } : {}),
    ...(first(input, scope.currency) !== undefined ? { currency: bounded(first(input, scope.currency), bounds.currency) } : {}),
    ...(first(input, scope.visibility) !== undefined ? { visibility: bounded(first(input, scope.visibility), bounds.target) } : {}),
  };
}

/** The identity of exactly what a person would approve: the tool and its input. */
export const approvalIdentity = (tool, input) => identityOf({ tool: tool?.name, input: input ?? null });

/**
 * The person's approvals, kept by the owner: approve({ scope, identity?, tool?, class?, expires_at_ms }) with a scope from
 * src/consequence-classes.json `approvals.scopes`. A `once` approval names the identity shown and is used up by the call it
 * lets run; `tool` and `class` approvals are allow-always until they end. Each must end within max_seconds of its scope.
 */
export function makeApprovals({ now = () => Date.now(), rules = table.approvals } = {}) {
  const grants = [];
  return {
    approve(grant) {
      const seconds = rules.max_seconds[grant?.scope];
      if (!rules.scopes.includes(grant?.scope) || seconds === undefined) throw new Error(`An approval has a scope of ${rules.scopes.join(', ')}.`);
      if (!Number.isFinite(grant.expires_at_ms) || grant.expires_at_ms <= now() || grant.expires_at_ms > now() + seconds * 1000) throw new Error(`An approval ends in the future and within ${seconds} seconds.`);
      if ((grant.scope === 'once' && !grant.identity) || (grant.scope === 'tool' && !grant.tool) || (grant.scope === 'class' && !grant.class)) throw new Error(`A ${grant.scope} approval names what it covers.`);
      grants.push({ ...grant });
    },
    /** Whether a call is approved now; a `once` approval that covers it is used up. */
    covers({ row, tool, identity }) {
      const at = now();
      const live = grants.filter(grant => grant.expires_at_ms > at);
      grants.splice(0, grants.length, ...live);
      const found = live.find(grant => (grant.scope === 'class' && grant.class === row.id) || (grant.scope === 'tool' && grant.tool === tool?.name) || (grant.scope === 'once' && grant.identity === identity));
      if (found?.scope === 'once') grants.splice(grants.indexOf(found), 1);
      return Boolean(found);
    },
  };
}

/**
 * null while the call may run. Otherwise { class, mode, scope, approval_identity, words }: the call waits for the person
 * (confirm_now: the owner's `approvals` must cover it; handoff: they do it).
 * modes: { class_id: mode } the person or space switched on; absent classes are `none`.
 */
export function consequenceHold({ tool, input, modes = {}, approvals = null, now = Date.now() }) {
  const row = classOf(tool);
  const mode = row ? (modes[row.id] ?? row.mode) : 'none';
  if (!row || mode === 'none') return null;
  const identity = approvalIdentity(tool, input);
  if (mode === 'confirm_now' && approvals?.covers({ row, tool, identity, now })) return null;
  const scope = scopeOf(row, input);
  return {
    class: row.id, mode, scope, approval_identity: identity,
    words: mode === 'handoff' ? `${row.label}: only the person does this. Hand it to them.`
      : `${row.label}: needs the person's yes for exactly this action. It waits until they approve it.`,
  };
}
