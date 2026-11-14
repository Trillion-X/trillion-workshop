// tools/decide-with-a-method/method-rows/answers.mjs
//
// The answers to a method, recorded in one call for any number of its rows. The person's own order, Nov 14 2026: stop the old decision
// engine that asks one step, then one judge per check, and build the new way: the AI reads the method's rows in one pass
// (method-rows/view.mjs), answers as many of them as it can, and records them together with the rows each answer
// cites and the decision's evidence it rests on; code checks the citations and the answer's strictness, and nothing here
// asks a model (case source:ZGVjaXNpb24tdG9vbC1pcy1yb3dzLWFuZC12aWV3cy0yMDI2LTExLTE0).
//
// An answer is one record of its own, `method-answer:<decision>:<row id, URI-encoded>`, so a method of any size is
// answered by any number of calls, an answer is read or changed on its own, and the decision's own record is not written.
//
// Non-Negotiable Invariants:
//   1. An answer is recorded only if its row is a row of the method, every row it cites is a row of the method, every
//      evidence ref it cites is evidence of the decision, and it passes its strictness. One that fails is named, with why,
//      and nothing of it is written; the others in the call are recorded, so one wrong answer never holds up the rest.
//   2. How strictly an answer is checked is an open value on its row, or on the method, or the default of
//      method-rows/settings.json: a rule tree in the vocabulary of the person's own view rules, decided by the rule filter
//      of tools/formulas. No level, kind of row or number of checks is named here, and nothing here asks a judge.
//   3. A review is asked only where the strictness says `review`: the answer is kept with review `asked`, which the rule of
//      starting-rules.json hands to an AI. Everywhere else the cheap check is the whole check.
//   4. The same answer again is no new version; a different answer for a row is its next version, and the earlier one stays
//      readable in the record's own history.
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { refuse, refuseUnknownFields, rowsOfMethod, say, strictnessOf } from './view.mjs';
import methodRows from './settings.json' with { type: 'json' };
import decide from '../read-data/decide-with-a-method.json' with { type: 'json' };

const { answers: ANSWERS, strictness: STRICT, evidence: EVIDENCE, pursuit: PURSUIT_TYPE } = methodRows;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const textList = value => value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0));
const answerKey = (decision, row) => `${ANSWERS.type}:${decision}:${encodeURIComponent(row)}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Whether one answer passes a rule tree, and, when it does not, the rules of the tree it fails, each one tried alone.
function judged(answer, tree) {
  const fields = STRICT.answer_fields.map(field => ({ id: field.id, kind: field.kind, path: ['value', field.id] }));
  const record = { value: { answer: answer.answer, cites: answer.cites, evidence_refs: answer.evidence_refs } };
  const found = filterRecords({ records: [record], fields, tree });
  if (found.incomplete?.length) return { unusable: JSON.stringify(found.incomplete).slice(0, 300) };
  if (found.matches.length === 1) return { passed: true };
  const failed = [];
  const leaves = node => (node?.kind === 'rule' ? [node] : (node?.rules ?? []).flatMap(leaves));
  for (const leaf of leaves(tree)) {
    if (filterRecords({ records: [record], fields, tree: leaf }).matches.length !== 1) failed.push(`${leaf.field} ${leaf.operator}`);
  }
  return { passed: false, failed };
}

// The refs of the decision's evidence, from its root and from the evidence records laid beside it, whichever layout it was
// kept in; evidence retracted is not citable. A decision that is not there is refused. A ref that is not evidence is citable only
// as one of the person's current pursuits (the same rule a decision's own citations keep).
async function evidenceRefsOf(door, decision) {
  const root = await door.read(EVIDENCE.root_type, decision);
  if (!object(root)) refuse('decision_not_found', { decision });
  const held = [...(Array.isArray(root.input?.evidence) ? root.input.evidence : [])];
  for await (const row of door.list({ type: EVIDENCE.type, prefix: `${EVIDENCE.type}:${decision}:` })) held.push(row.value);
  return new Set(held.filter(item => object(item) && !item.retracted_at && nonempty(item.ref)).map(item => item.ref));
}

// What a review of one answer is asked with: the answer is kept with review asked, and the words and label the shipped rule
// of starting-rules.json hands to an AI.
const reviewAsked = (decision, method, row) => ({
  [STRICT.review_field]: STRICT.review_asked,
  [STRICT.review_job_field]: say('review_job', { decision, method, row, row_key: encodeURIComponent(row) }),
  [STRICT.review_said_field]: say('review_said', { row }),
});

function shapeOf(item, position, refusals) {
  const ok = object(item) && nonempty(item.row) && typeof item.answer === 'string' && textList(item.cites) && textList(item.evidence_refs);
  if (!ok) refusals.push({ row: object(item) && nonempty(item.row) ? item.row : `#${position}`, why: say('answer_shape', { position }) });
  return ok;
}

/** tool:record-method-answers. input { decision_id, method, answers: [{ row, answer, cites?, evidence_refs? }], by? }. */
export async function recordMethodAnswers(input, { door }) {
  refuseUnknownFields('tool:record-method-answers', input);
  if (!nonempty(input?.decision_id)) refuse('no_decision');
  if (!nonempty(input.method)) refuse('no_method');
  if (!Array.isArray(input.answers) || input.answers.length < 1) refuse('no_answers');
  const by = input.by ?? ANSWERS.default_by;
  if (!nonempty(by) || by.length > ANSWERS.by_max_chars) refuse('by_too_long', { count: ANSWERS.by_max_chars });
  const evidence = await evidenceRefsOf(door, input.decision_id);
  const { record, rows } = await rowsOfMethod(door, input.method);
  const byId = new Map(rows.map(row => [row.id, row]));
  const pursuits = new Map();
  const citable = async ref => {
    if (evidence.has(ref)) return true;
    if (!pursuits.has(ref)) { const pursuit = await door.read(PURSUIT_TYPE, ref); pursuits.set(ref, object(pursuit) && pursuit.status !== 'ended'); }
    return pursuits.get(ref);
  };
  const kept = new Map();
  for await (const held of door.list({ type: ANSWERS.type, prefix: `${ANSWERS.type}:${input.decision_id}:` })) kept.set(held.id, held.value);

  const refused = [];
  const seen = new Set();
  const records = [];
  const unchanged = [];
  const now = new Date().toISOString();
  for (const [position, item] of input.answers.entries()) {
    if (!shapeOf(item, position, refused)) continue;
    const refuseRow = (name, parts) => refused.push({ row: item.row, why: say(name, { row: item.row, method: input.method, decision: input.decision_id, ...parts }) });
    if (seen.has(item.row)) { refuseRow('row_twice'); continue; }
    seen.add(item.row);
    const target = byId.get(item.row);
    if (!target) { refuseRow('row_not_in_method'); continue; }
    const cites = item.cites ?? [], refs = item.evidence_refs ?? [];
    if (cites.length + refs.length > ANSWERS.most_cites) { refuseRow('too_many_cites', { count: ANSWERS.most_cites }); continue; }
    const strayCite = cites.find(cite => !byId.has(cite));
    if (strayCite !== undefined) { refuseRow('cite_not_in_method', { cite: strayCite }); continue; }
    let strayRef;
    for (const ref of refs) if (!(await citable(ref))) { strayRef = ref; break; }
    if (strayRef !== undefined) { refuseRow('evidence_not_in_decision', { ref: strayRef }); continue; }
    if (Buffer.byteLength(item.answer) > ANSWERS.most_bytes) { refuseRow('answer_too_large', { count: ANSWERS.most_bytes }); continue; }
    const strictness = strictnessOf(target.values, record);
    const verdict = judged({ answer: item.answer, cites, evidence_refs: refs }, strictness.rules);
    if (verdict.unusable) { refuseRow('strictness_unusable', { why: verdict.unusable }); continue; }
    if (!verdict.passed) { refuseRow('strictness_unmet', { why: strictness.says ?? verdict.failed.join(', ') }); continue; }
    const id = answerKey(input.decision_id, item.row);
    const before = kept.get(id);
    if (before && same([before.answer, before.cites, before.evidence_refs], [item.answer, cites, refs])) { unchanged.push(item.row); continue; }
    records.push({ id, type: ANSWERS.type, value: {
      decision_id: input.decision_id, method: input.method, row: item.row, answer: item.answer, cites, evidence_refs: refs,
      strictness: strictness.from, ...(strictness.review === true ? reviewAsked(input.decision_id, input.method, item.row) : {}),
      answered_at: now, by, version: (before?.version ?? 0) + 1,
    } });
  }

  const recorded = [];
  for (const batch of writeBatches(records, { rows: decide.writes, bytes: decide.write_bytes })) {
    const key = `record-method-answers:${input.decision_id}:${makeHashCodeHexFromBytes(Buffer.from(JSON.stringify(batch.map(record => [record.id, record.value.version, record.value.answer, record.value.cites, record.value.evidence_refs]))))}`;
    await door.write(batch, { key });
    recorded.push(...batch.map(record => ({ row: record.value.row, version: record.value.version, ...(record.value[STRICT.review_field] ? { review: record.value[STRICT.review_field] } : {}) })));
  }
  const answered = new Set([...kept.values()].map(value => value.row).filter(row => byId.has(row)));
  for (const item of recorded) answered.add(item.row);
  return { decision_id: input.decision_id, method: input.method, recorded, unchanged, refused, answered: answered.size, rows: rows.length };
}

/** The rows of a method and which of them the decision has an answer for: { rows, answered, unanswered: [row ids] }. */
export async function methodAnswered(door, decision, method) {
  const { rows } = await rowsOfMethod(door, method);
  const kept = new Set();
  for await (const held of door.list({ type: ANSWERS.type, prefix: `${ANSWERS.type}:${decision}:` })) kept.add(held.value.row);
  const unanswered = rows.map(row => row.id).filter(id => !kept.has(id));
  return { rows: rows.length, answered: rows.length - unanswered.length, unanswered };
}
