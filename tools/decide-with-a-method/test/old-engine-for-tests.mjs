// The harness the tests ported from old trillion's DecisionEngine tests share (test/cost, guided, guide-answer-flat,
// judge-reads-the-case, decision-own-reads and the rest; tag old-trillion-before-worker-retire, b6ae0ebf81, deleted by
// Trillion-X/trillion #243). Those tests drove src/engine.mjs over a SQLite store and filled each question with
// scripts/fill-answer.mjs; here the same walks run over this tool's door tools and fixtures.mjs's in-memory door:
// `account` puts the made-up method in the person's Checks list, `fill` answers a question to its declared shape the way
// fill-answer did, `judged` is the second judge's passing verdicts on every check a question asks, and `counting` wraps a
// door so a test can bound what a call reads through it (the old tests counted SQL statements and rows of the store).
import { readFileSync } from 'node:fs';
import { memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';

export const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const CHECK = `record:${settings.records.check_row}`;

/** A door holding the made-up method and its check rows (or the ones given), as the person's own Checks list. */
export function account({ door = memoryDoor(), method = plainMethod(), checks = plainChecks() } = {}) {
  door.put(`${CHECK}:${method.id}`, CHECK, method);
  for (const check of checks) door.put(`${CHECK}:${check.id}`, CHECK, check);
  return door;
}

const words = name => `A made-up ${name.replace(/_/g, ' ')} in its own words`;
function valueFor(name, schema) {
  if (!schema) return words(name);
  if (schema.type === 'array') return [words(`${name} item`)];
  if (schema.format === 'date' || /date/i.test(schema.description ?? '') || /\\d\{4\}/.test(schema.pattern ?? '')) return today();
  if (schema.type === 'object' && schema.properties) return Object.fromEntries((schema.required ?? Object.keys(schema.properties)).map(key => [key, valueFor(key, schema.properties[key])]));
  return words(name);
}

/** An answer to `question` filled to its declared shape (old scripts/fill-answer.mjs): every switch of a scope question
 * set from `switches` (false when not named) with the reason each switch turned off asks for; every field of any other
 * step; every check of its checklist handled in its own words; each citing `refs`. */
export function fill(question, { refs, switches = {} } = {}) {
  const properties = question.answer_schema?.properties ?? {};
  if (question.step_id === 'scope' || properties.decision_context) {
    const decision_context = {};
    const omission_reasons = {};
    for (const check of question.checks ?? []) {
      decision_context[check.id] = switches[check.id] ?? false;
      if (!decision_context[check.id]) {
        const reason = { evidence_refs: refs };
        for (const spec of check.skip_requires ?? []) reason[spec.name] = spec.kind === 'list' ? [words(`${spec.name} place`)] : words(spec.name);
        omission_reasons[check.id] = reason;
      }
    }
    return { decision_context, omission_reasons, evidence_refs: refs };
  }
  const answer = { evidence_refs: refs };
  for (const name of question.answer_schema?.required ?? []) {
    if (name === 'evidence_refs' || name === 'checklist') continue;
    answer[name] = valueFor(name, properties[name]);
  }
  if (question.checklist?.length) answer.checklist = Object.fromEntries(question.checklist.map(row => [row.id, { handled: true, how: `Handled ${row.id} for this decision`, evidence_refs: refs }]));
  return answer;
}

/** The second judge's passing verdict on every check `question` asks, each resting on the evidence ref `ref`. */
export const judged = (question, ref) => (question?.verdict_checks ?? []).map(check => ({ check, meets: true, rests_on: ref, graded_by: 'second-judge-test' }));

/** `door` with every read and every listed row counted: `reads` (ids read one by one), `listed` (rows a list handed
 * back, by type), and `take()` that returns them and starts again. */
export function counting(door) {
  let reads = [];
  let listed = [];
  const wrapped = Object.create(door);
  wrapped.read = async (type, id) => { reads.push({ type, id }); return door.read(type, id); };
  wrapped.list = async function* (query) { for await (const row of door.list(query)) { listed.push({ type: query.type, id: row.id }); yield row; } };
  wrapped.write = (...args) => door.write(...args);
  return Object.assign(wrapped, {
    get reads() { return reads; },
    get listed() { return listed; },
    crossed: () => reads.length + listed.length,
    take() { const taken = { reads, listed, crossed: reads.length + listed.length }; reads = []; listed = []; return taken; },
  });
}

/** `count` made-up pursuits written as the pursuit tools write them: one `pursuit` record each. */
export function putPursuits(door, count, shape = n => ({ title: `Goal ${n}`, now: `Before ${n}`, after: `After ${n}`, why_it_matters: 'x'.repeat(300), status: 'active' }), name = n => `pursuit:p${n}`) {
  for (let n = 0; n < count; n += 1) door.put(name(n), 'pursuit', { id: name(n), ...shape(n) });
}
