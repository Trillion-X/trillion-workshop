// src/tool-call-refusal.mjs
//
// Purpose: the one place a tools/call is checked against the caller's current tool list before anything runs, and the
// one place a refusal is worded. A refusal says why and whether asking again can help, so an AI does not loop on a
// call that can never work (unknown name), and fixes one that can (a spelling that matches more than one tool).
//
// Non-negotiable invariants
//   1. The caller's current list is the only truth: a name not in it (a revoked grant, a tool of another space) is
//      refused, never guessed. A former name (src/renamed-tools.json) is resolved by the caller before this runs.
//   2. A name that differs from exactly one listed name only in case or punctuation is not run; the refusal names it.
//      A name that matches several is refused as ambiguous and lists them.
//   3. Words, retry advice and reasons are DATA (src/tool-call-refusal.json); this file names no tool.
//   4. A refusal is the same for a single call and a batch member: both ask `refusalFor`.
import settings from '../../shared-code/src/tool-call-refusal.json' with { type: 'json' };

const keyOf = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
const fill = (text, matches) => text.replace('{matches}', matches.join(', '));

const refusal = (reason, name, matches = []) => ({
  reason,
  message: reason === 'unknown_tool' || reason === 'did_you_mean' || reason === 'ambiguous_name' ? `Unknown tool ${name}` : 'Malformed tool call',
  data: { reason, retry: settings.reasons[reason].retry, words: fill(settings.reasons[reason].words, matches), ...(matches.length ? { matches } : {}) },
});

/** A refusal { reason, message, data } for a call that must not run, or null. `resolved` is the tool the caller found. */
export function refusalFor({ name, args, toolsByName, resolved }) {
  if (typeof name !== 'string' || !name || (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args)))) return refusal('malformed_call', name);
  if (resolved) return null;
  const key = keyOf(name);
  const matches = [...toolsByName.keys()].filter(listed => keyOf(listed) === key);
  if (matches.length > 1) return refusal('ambiguous_name', name, matches);
  if (matches.length === 1) return refusal('did_you_mean', name, matches);
  return refusal('unknown_tool', name);
}

/** The refusal for an authority check that itself failed (the call did not run, trying again shortly may help). */
export const checkFailedRefusal = name => refusal('check_failed', name);

/** The JSON-RPC error a refusal is sent as: the old "Unknown tool <name>" line plus the typed data. */
export const refusalAsError = (found, extra = {}) => ({ code: found.reason === 'malformed_call' ? -32602 : -32603, message: found.message, data: { ...found.data, ...extra } });
