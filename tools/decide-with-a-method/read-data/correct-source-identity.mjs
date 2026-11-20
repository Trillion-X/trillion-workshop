// tools/decide-with-a-method/read-data/correct-source-identity.mjs
//
// PURPOSE
//   tool:correct-source-identity: a saved message decision that falsely targets the chat of a different app is corrected
//   to continue its handoff in its original chat. Ported from the old engine (old codebase commit b6ae0ebf815f,
//   src/engine.mjs correctSourceIdentity and the route in src/person-store.mjs). The caller reads the kept person message,
//   its source chat and the handoff by SQL and hands them in as `facts`; this file checks them and writes only the decision.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A correction needs a kept message the person sent, a source chat of that message's own app, and a handoff that
//      arrived from that message: any mismatch is refused, and nothing is written.
//   2. A correction rewrites the decision's reason, next action, success measure and move; the replaced decision moves to
//      decision_history and the generation rises by one.
//   3. An exact repeat of the same correction changes nothing and answers already_corrected.
import { canonical, decisionId, decisionOrRefuse, keepDecision } from './decisions.mjs';
import { recordsIn } from './decision-records.mjs';
import words from './correct-source-identity.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const same = (a, b) => canonical(a) === canonical(b);
const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));

// The kept message, its source chat and the handoff must agree with the message the decision came from.
function verifiedFacts({ message_id, source_id, handoff_id, handoff_agent, facts }) {
  if (!nonempty(message_id) || !nonempty(source_id) || !new RegExp(words.handoff_id_pattern).test(handoff_id ?? '')) throw new Error(words.refuse.unverified);
  const { message, source, handoff } = facts ?? {};
  const arrived = handoff?.input?.arrived;
  if (!object(message) || message.id !== message_id || message.speaker !== 'person' || message.conversation_id !== source_id
    || !object(source) || source.id !== source_id || source.app !== message.app || !nonempty(source.app)
    || !object(handoff) || handoff.handoff_id !== handoff_id || handoff.from_agent !== handoff_agent
    || arrived?.message_id !== message_id || arrived?.source_id !== source_id || arrived?.from_person !== true) throw new Error(words.refuse.mismatch);
  return source.app;
}

/**
 * tool:correct-source-identity. input { decision_id, message_id, source_id, handoff_id, handoff_agent, facts, apps, records }:
 * `handoff_agent` is the agent name the handoff must carry, `facts` is { message, source, handoff } as the caller read them,
 * `apps` the names of the known apps, `records` what the caller read.
 * Answers { case_id, decision, decision_generation, already_corrected, keep }.
 */
export function correctSourceIdentity(input) {
  const app = verifiedFacts(input);
  const held = recordsIn(input);
  const id = decisionId(input);
  const record = decisionOrRefuse(held, id);
  const { message_id: messageId, source_id: sourceId, handoff_id: handoffId } = input;
  if (record.source_id !== messageId || record.decision?.option_id !== words.act_option || record.source_provenance?.valid === false) throw new Error(words.refuse.not_active);
  const parts = { source_id: sourceId, handoff_id: handoffId, app };
  const next = {
    ...record.decision,
    reason: fill(words.reason, parts),
    next_action: fill(words.next_action, parts),
    success_measure: fill(words.success_measure, parts),
    move: fill(words.move, parts),
  };
  if (same(record.decision, next)) return { case_id: id, decision: record.decision, decision_generation: record.decision_generation ?? 1, already_corrected: true, keep: [] };
  const said = [record.decision.reason, record.decision.next_action, record.decision.success_measure].join(' ').toLowerCase();
  const otherApps = (input.apps ?? []).filter(name => !app.includes(name));
  const earlier = record.decision_history?.some(item => item.reason === words.correction_reason && item.message_id === messageId
    && item.source_id === sourceId && item.handoff_id === handoffId);
  if (!earlier && !otherApps.some(name => said.includes(name.toLowerCase()))) throw new Error(words.refuse.unproven);
  const correctedAt = new Date().toISOString();
  record.decision_history ??= [];
  record.decision_history.push({ decision: record.decision, decided_at: record.decided_at, revised_at: correctedAt, reason: words.correction_reason, source_id: sourceId, message_id: messageId, handoff_id: handoffId });
  record.decision = next;
  record.decision_generation = (record.decision_generation ?? 1) + 1;
  record.corrected_at = correctedAt;
  return { case_id: id, decision: next, decision_generation: record.decision_generation, already_corrected: false, keep: keepDecision(held, record) };
}
