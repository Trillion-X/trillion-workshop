// tools/decide-with-a-method/read-data/similar-decisions.mjs
//
// The person's own earlier decisions brought back when a similar one comes up: at the moment of choice, what was
// decided in decisions like this one and how each turned out. Ported from the old app's DecisionEngine.related
// (src/engine.mjs) over the person's `decision` records, read through the records door the run was handed.
//
// A decision is weighed on its goal and method alone, read from the newest decisions' own fields (`input` and
// `method_id`, never their method snapshot, answers or calls), and only the few kept are read whole. A decision whose
// root predates method_id is weighed as the default method until its next change writes it. The look back is bounded, never every decision.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only this person's own decision records are read; nothing leaves their account.
//   2. The asked decision is never offered as similar to itself; a removed decision is absent from the list, so it
//      is never offered.
//   3. Every weight and bound is read from read-data/decide-with-a-method.json, none is written here.
import { readFileSync } from 'node:fs';
import { decisionStatus } from './decision-outcome.mjs';

const settings = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const { similar, precedence, words: WORDS } = settings;
const WORD = new RegExp(similar.word, 'g');

const refuse = message => { throw Object.assign(new Error(message), { code: 'refused' }); };
const wordsOf = text => new Set(String(text ?? '').toLowerCase().match(WORD) ?? []);
// A decision's method: its root's method_id, else its snapshot's id (a root written before method_id), else the default.
const methodOf = record => record?.method_id ?? record?.method?.id ?? similar.default_method;

/** How close another decision's goal and method are to this one's: shared words, plus the same method. */
export function closeness(mine, method, other) {
  return [...wordsOf(other.goal)].filter(word => mine.has(word)).length + (other.method === method ? similar.same_method : 0);
}

/** The kept ones among the newest goals, closest first. */
export function closest(record, goals, limit) {
  const mine = wordsOf(record.input?.goal);
  const method = methodOf(record);
  return goals
    .filter(other => other.id !== record.id)
    .map(other => ({ id: other.id, score: closeness(mine, method, other) }))
    .filter(item => item.score > similar.above)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** One earlier decision as it is brought back: what was decided, what was next, and how it turned out. */
export function broughtBack(other) {
  return {
    case_id: other.id, goal: other.input?.goal ?? '', method: methodOf(other),
    decision: other.decision ? other.input?.options?.find(option => option.id === other.decision.option_id)?.label ?? null : null,
    next_action: other.decision?.next_action ?? null, status: decisionStatus(other, precedence) ?? null,
    observed: (other.observations ?? []).map(item => ({ result: item.result, summary: item.summary ?? null })),
    reported: (other.reports ?? []).map(item => ({ result: item.result, summary: item.summary })),
  };
}

/** tool:bring-back-similar-decisions. input { decision_id, limit? } -> { similar_decisions: [...] } */
export async function similarDecisions({ decision_id: id, limit } = {}, { door }) {
  if (typeof id !== 'string' || !id) refuse(WORDS.no_decision);
  const most = Math.min(Number.isInteger(limit) && limit > 0 ? limit : similar.limit, similar.most);
  const record = await door.read('decision', id);
  if (!record) refuse(WORDS.not_found);
  const goals = [];
  for await (const row of door.list({ type: 'decision', order: similar.order, reverse: true, fields: ['input', 'method_id'], limit: similar.look_back })) {
    goals.push({ id: row.id, goal: row.value?.input?.goal ?? '', method: methodOf(row.value) });
    if (goals.length >= similar.look_back) break;
  }
  const kept = [];
  for (const { id: keptId } of closest({ ...record, id }, goals, most)) {
    const other = await door.read('decision', keptId);
    if (other) kept.push(broughtBack({ ...other, id: keptId }));
  }
  return { similar_decisions: kept };
}
