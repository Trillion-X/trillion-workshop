// src/handoff-notice.mjs
//
// Purpose
//   Turns one moment of a handoff (src/agents.mjs tell) into the notice an AI is shown on its next tool reply
//   (src/notices.mjs): work waiting for the agent it was handed to, work waiting for whichever AI takes it first, or
//   work finished for the AI that handed it off. An AI that only runs when the person opens it (a chat app) has no
//   address to be woken at, so this notice, addressed to its reader and kept whatever its age, is how it hears of work.
//
// Non-negotiable invariants
//   1. Every word comes from src/notices.json handoff_notices, one row per moment; a moment with no row makes no notice.
//   2. One notice per handoff and kind: the key is the handoff id, so handing the same work off again adds nothing.
//   3. A notice carries the job in words (cut to job_max) and ids, never the handoff's input or result.
//   4. A row's `next_call` ({ tool, arguments } with {field} filled from the handoff) is the call that acts on it.
//
import settings from './notices.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The notice for one handoff moment, or null when notices.json has no words for that moment. */
export function handoffNotice({ moment, handoff, for_reader = null, from_reader = null }, rules = settings) {
  const row = rules.handoff_notices?.[moment];
  if (!row || !handoff?.handoff_id) return null;
  const said = fill(row.said, { ...handoff, job: cut(String(handoff.job ?? ''), rules.handoff_notices.job_max) });
  const next_call = row.next_call ? { tool: row.next_call.tool, arguments: Object.fromEntries(Object.entries(row.next_call.arguments ?? {}).map(([name, template]) => [name, fill(template, handoff)])) } : null;
  return { kind: row.kind, key: handoff.handoff_id, from_reader, for_reader, refs: { handoff_id: handoff.handoff_id }, said, next_call };
}
