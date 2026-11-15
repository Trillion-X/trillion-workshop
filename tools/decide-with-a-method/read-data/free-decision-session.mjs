// The retired free-run's request-local store over today's decision tools. Only method/check reads reach the real
// records door. All writes stay in this call and are discarded; the compact sealed run is the only continuation.
import { readFileSync } from 'node:fs';
import { canonical, keepDecision, rowsOf, startADecision, nextDecisionQuestion, answerADecisionQuestion, addDecisionEvidence, makeTheDecision } from './decisions.mjs';
import { readDecision } from './decision-records.mjs';
import { methodCatalogue } from './method.mjs';

const settings = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const methodType = `record:${settings.records.method_row}`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const catalogue = (methods, checks = []) => methodCatalogue(methods, checks, { grader: settings.grader, link: [settings.records.method_link, ...(settings.records.old_method_links ?? [])] });
const start = (input, session) => {
  if (!Array.isArray(input?.options)) throw new Error('Free decisions need their named options before starting.');
  return startADecision(input, { door: session.door });
};

export function decisionSession(store, { door }) {
  const held = new Map(Object.values(store.current().cases).map(record => [record.id, { type: 'decision', value: structuredClone(record) }]));
  const local = {
    async read(type, id) {
      if (type === methodType) return door.read(type, id);
      const record = held.get(id);
      return record?.type === type ? structuredClone(record.value) : null;
    },
    async *list(query) {
      if (query.type === methodType) { yield* door.list(query); return; }
      // A free run has no history, pursuits or other decisions.
      for (const [id, record] of held) if (record.type === query.type && id.startsWith(query.prefix ?? '') &&
        Object.entries(query.where ?? {}).every(([name, value]) => canonical(record.value[name]) === canonical(value))) {
        yield { id, type: record.type, value: structuredClone(record.value) };
      }
    },
    async write(records) {
      for (const record of records) if ('expected' in record && canonical(record.expected) !== canonical(held.get(record.id) ?? null)) {
        throw Object.assign(new Error('The decision changed since it was read.'), { code: 'original_command_conflict' });
      }
      for (const { id, type, value } of records) {
        if (type === methodType) throw new Error('A free decision cannot change its method.');
        if (value === null) held.delete(id); else held.set(id, { type, value: structuredClone(value) });
      }
      return { changed: true, write_count: records.length };
    },
  };
  return {
    door: local,
    async flush() {
      const cases = {};
      for (const [id, record] of held) if (record.type === 'decision') cases[id] = await readDecision(local, id, (record.value.guidance ?? []).map(step => step.step_id));
      // Read every step accepted in this call, including steps now stored apart from the root.
      for (const [id, record] of Object.entries(cases)) cases[id] = await readDecision(local, id, record.guidance.map(step => step.step_id));
      await store.write({ cases, pursuits: {} });
    },
  };
}

async function reviseEvidence(door, id, { add = [], correct = [], retract = [] } = {}) {
    if (![add, correct, retract].every(Array.isArray) || add.length + correct.length + retract.length === 0) throw new Error('Give add, correct or retract');
    for (const item of [...add, ...correct]) if (!object(item) || !nonempty(item.ref) || !nonempty(item.claim)) throw new Error('Each added or corrected fact needs a ref and a claim');
    if (!retract.every(ref => nonempty(ref) || (object(ref) && nonempty(ref.ref)))) throw new Error('Each retraction names a ref');
      const record = await readDecision(door, id);
      if (!record) throw new Error('Case not found');
      if (record.decision) throw new Error('This case already has a decision; evidence is revised before deciding');
      record.original_input ??= structuredClone(record.input);
      const at = new Date().toISOString();
      const byRef = new Map(record.input.evidence.map(item => [item.ref, item]));
      const problems = [];
      for (const item of add) byRef.has(item.ref) ? problems.push(`${item.ref} is already evidence; correct it instead`) : byRef.set(item.ref, { ref: item.ref, claim: item.claim });
      for (const item of correct) byRef.has(item.ref) && !byRef.get(item.ref).retracted_at ? byRef.set(item.ref, { ...byRef.get(item.ref), claim: item.claim, corrected_at: at }) : problems.push(`${item.ref} is not current evidence`);
      for (const entry of retract) {
        const ref = object(entry) ? entry.ref : entry;
        byRef.has(ref) && !byRef.get(ref).retracted_at ? byRef.set(ref, { ...byRef.get(ref), retracted_at: at, ...(object(entry) && nonempty(entry.because) ? { retracted_because: entry.because } : {}) }) : problems.push(`${ref} is not current evidence`);
      }
      if (problems.length) throw new Error(problems.join('; '));
      if (![...byRef.values()].some(item => !item.retracted_at)) throw new Error('A case needs at least one current fact');
      record.input.evidence = [...byRef.values()];
      (record.evidence_history ??= []).push({ at, add, correct, retract });
      await keepDecision(door, record, `free-evidence:${id}`);
      return { case_id: id, evidence: record.input.evidence.filter(item => !item.retracted_at), retracted: record.input.evidence.filter(item => item.retracted_at).map(item => item.ref) };
}


async function questions(session, input) {
  const { scope_answer, ...opened } = input;
  const reply = await start(opened, session);
  const record = await readDecision(session.door, reply.case_id);
  const methods = await rowsOf(session.door, settings.records.method_row, settings.records.method_where);
  const cat = catalogue(methods);
  const questions = [cat.currentQuestion(record)];
  if (scope_answer !== undefined) {
    const first = cat.stepsFor(record)[0];
    cat.validateMethodAnswer(record, first, scope_answer, new Set(record.input.evidence.map(item => item.ref)));
    record.guidance.push({ step_id: first.id, answer: scope_answer });
    for (const step of cat.stepsFor(record).slice(1)) {
      const checks = await rowsOf(session.door, settings.records.check_row, { step: step.id });
      for (const id of step.check_ids ?? []) checks.push(...await rowsOf(session.door, settings.records.check_row, { [settings.records.check_id_field]: id }));
      const current = catalogue(methods, checks);
      questions.push(current.currentQuestion(record));
      record.guidance.push({ step_id: step.id, answer: {} });
    }
  }
  return { case_id: reply.case_id, questions, ...(scope_answer !== undefined ? { decision_fields: cat.decisionFieldsAsked(record) } : {}) };
}

/** Compatibility for only the routes the original free-run admits. Current tools enforce shape and verdict rules. */
export async function handleCaseRequest(session, request) {
  const path = new URL(request.url).pathname;
  try {
    const input = request.method === 'POST' ? await request.json() : null;
    let reply;
    if (path === '/cases/one-pass/questions') reply = await questions(session, input);
    else if (path === '/cases/one-pass') {
      const { answers, decision, usage, ...opened } = input;
      if (!Array.isArray(answers) || !answers.length) throw new Error('answers must name every question in order.');
      reply = await start(opened, session);
      for (const answer of answers) reply = await answerADecisionQuestion({ ...answer, decision_id: reply.case_id }, { door: session.door });
      const { verdicts, ...chosen } = decision;
      reply = await makeTheDecision({ decision_id: reply.case_id, decision: chosen, verdicts, usage }, { door: session.door });
    } else if (path === '/cases') reply = await start(input, session);
    else {
      const match = path.match(/^\/cases\/([^/]+)\/(guide|agent-decision|evidence)$/);
      if (!match) return Response.json({ error: 'Not found' }, { status: 404 });
      const decision_id = decodeURIComponent(match[1]);
      if (match[2] === 'guide') reply = await (request.method === 'GET' ? nextDecisionQuestion({ decision_id }, { door: session.door }) : answerADecisionQuestion({ ...input, decision_id }, { door: session.door }));
      else if (match[2] === 'agent-decision') {
        const { verdicts, usage, ...decision } = input;
        reply = await makeTheDecision({ decision_id, decision, verdicts, usage }, { door: session.door });
      } else reply = input.evidence ? await addDecisionEvidence({ ...input, decision_id }, { door: session.door }) : await reviseEvidence(session.door, decision_id, input);
    }
    await session.flush();
    return Response.json(reply);
  } catch (error) {
    return Response.json({ error: error.message, ...(error.problems ? { problems: error.problems } : {}) }, { status: 400 });
  }
}
