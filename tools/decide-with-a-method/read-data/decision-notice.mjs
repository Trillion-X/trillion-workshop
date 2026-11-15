// src/decision-notice.mjs
//
// Purpose
//   Turns one made decision into the notice every other AI of the person is shown (src/notices.mjs) and the event its
//   published agents are woken with (src/agents.mjs tellEveryone): the question, the option chosen (or the narrower
//   move), every field the decision's method asked for said in that method's own words (who it changes, for one),
//   the next action, and the case id an AI reads the whole decision with.
//
// Non-negotiable invariants
//   1. Every word comes from the decision record or from src/notices.json; the method's decision fields speak through
//      their own `says` sentence, so a method adding a field adds it to the notice with no change here.
//   2. One notice per decision generation: deciding again with the same words keeps the same key, so it is kept once.
//
import { methodCatalogue } from './method.mjs';
const decisionFieldsFor = record => methodCatalogue([record.method]).decisionFieldsFor(record);

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** The notice for a decided record, or null when the record holds no decision. `app` is the deciding app's name. */
export function decisionNotice(record, { app = null, from_reader = null } = {}, rules) {
  if (!record?.decision) return null;
  const { decision } = record;
  const words = rules.decision_words;
  const chosen = nonempty(decision.move) ? decision.move : record.input.options.find(option => option.id === decision.option_id)?.label ?? decision.option_id;
  const fields = decisionFieldsFor(record).filter(field => nonempty(decision[field.name]))
    .map(field => fill(field.says ?? `${field.label ?? field.name}: {value}.`, { value: decision[field.name] }));
  const said = [
    fill(nonempty(app) ? words.opening : words.opening_no_app, { app, question: record.input.goal }),
    fill(words.chosen, { chosen }),
    ...fields,
    fill(words.next, { next_action: decision.next_action }),
    fill(words.case, { case_id: record.id }),
  ].join(' ');
  return { kind: 'decision', key: `${record.id}:${record.decision_generation ?? 1}`, from_reader, refs: { case_id: record.id }, said };
}

/** The event a decision wakes published agents with: ids and the notice's words, cut to the rail's 300 characters. */
export const decisionEvent = (notice, rules) => ({
  type: rules.decision_event.type, key: notice.key, subject_id: notice.refs.case_id, refs: notice.refs,
  summary: notice.said.length > 300 ? `${notice.said.slice(0, 299)}…` : notice.said,
  next_call: { tool: rules.decision_event.next_tool, arguments: { case_id: notice.refs.case_id } },
});
