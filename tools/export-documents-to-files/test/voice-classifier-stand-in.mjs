// tools/export-documents-to-files/test/voice-classifier-stand-in.mjs
//
// A stand-in for the book-voice classifier's capture validator, for the writing gate's tests only. The gate calls the
// real one at tools/train-and-evaluate-a-writing-voice-classifier/read-data/evaluation-integrity.mjs (ported
// there from the launch-video tools/copy-gate/evaluate-book-voice-integrity.mjs); this file has its exported names and
// the parts of its checks the gate's tests lean on: the typed request plan (target, its kind and the reader context),
// a block kind that matches the block's text, no row-specific answer hint, and a report whose captured request and
// response agree with its saved choices. It is not the classifier and holds no person's data.
//
// As a script: `node voice-classifier-stand-in.mjs plans < DATA.json` prints each item's request plan, the report's
// criteria and the request policy, which the tests use to build captured reports.
import { isDeepStrictEqual } from 'node:util';
import { text } from 'node:stream/consumers';

const SCHEMAS = new Set(['book-voice-decider-challenge-v1', 'book-voice-decider-challenge-v2', 'book-voice-decider-challenge-v3']);
const fail = message => { throw new Error(message); };
const typed = input => input?.schema === 'book-voice-decider-challenge-v3';

export function requestPolicyFor(input) {
  if (typed(input) && input.criteria?.some(c => c.id === 'section-heading-fit' && c.section_chunk_request)) return 'typed-source-bound-section-chunks-v1';
  return typed(input) ? 'typed-target-and-pinned-reference-v1' : 'neutral-passage-and-criterion-context-v1';
}

export function classifyWritingBlock(value) {
  const lines = value.trim().split(/\r?\n/u).map(line => line.trim());
  if (lines.length === 1 && /^#{1,6}\s+\S.*$/u.test(lines[0])) return 'heading';
  if (lines.length >= 2 && lines.every(line => /^\|.*\|$/u.test(line))) return 'table';
  if (lines.every(line => /^>\s?/u.test(line))) return 'quote';
  if (lines.every(line => /^(?:[-+*]|\d+[.)])\s+\S/u.test(line))) return 'list';
  return 'paragraph';
}

const applies = (criterion, item, input) => !typed(input) || criterion.applies_to.includes(item.block_kind);

export function requestPlan(input, item, criteria = input.criteria) {
  const applicable = criteria.filter(criterion => applies(criterion, item, input));
  const references = [...new Set(applicable.map(c => c.reference_context).filter(Boolean))];
  const content = typed(input)
    ? JSON.stringify({ reference_text: references.length <= 1 ? (references[0] ?? '') : Object.fromEntries(applicable.map(c => [c.id, c.reference_context])),
      reader_context: item.reader_context ?? '', target_kind: item.block_kind, target_text: item.text })
    : `Passage: ${item.text}`;
  const asking = {};
  for (const criterion of applicable) {
    if (!typed(input) && Object.keys(item.checks ?? {}).length && !(criterion.id in item.checks)) continue;
    if (criterion.deterministic) continue;
    asking[criterion.id] = { question: typed(input) && criterion.reference_context ? `${criterion.question} Use reference_text.` : criterion.question,
      shape: { kind: 'one-of', options: criterion.options } };
  }
  return { content, asking };
}

export function reportCriteria(criteria) {
  return criteria.map(c => ({ id: c.id, question: c.question ?? null, deterministic: Boolean(c.deterministic),
    ...(c.reference_context === undefined ? {} : { reference_context: c.reference_context }),
    ...(c.applies_to === undefined ? {} : { applies_to: c.applies_to }) }));
}

export function validateInput(input) {
  if (!SCHEMAS.has(input?.schema) || !Array.isArray(input.items)) fail('unsupported challenge schema or items');
  for (const item of input.items) {
    if (typed(input) && item.block_kind !== classifyWritingBlock(item.text)) fail(`block kind of ${item.id} does not match its text`);
    if (typed(input) && item.check_context !== undefined) fail(`${item.id} carries a row-specific hint`);
  }
  return { evalItems: input.items.filter(item => item.split === 'eval'), criteria: input.criteria };
}

export function validateReport(report, expected) {
  const { evalItems, criteria } = validateInput(expected.input);
  if (report?.schema !== 'book-voice-decider-evaluation-v2') fail('unsupported report schema');
  if (report.data_blake3 !== expected.dataBlake3) fail('report names other DATA');
  const items = new Map(evalItems.map(item => [item.id, item]));
  for (const row of report.items) {
    const item = items.get(row.id) ?? fail(`unknown item ${row.id}`);
    const plan = requestPlan(expected.input, item, criteria);
    if (!isDeepStrictEqual(row.request_evidence?.adapter_input, plan)) fail(`changed request for ${row.id}`);
    const body = JSON.parse(row.request_evidence.exchanges.at(-1).response);
    if (body.model !== expected.model || body.served_identity !== expected.serving) fail(`response identity changed for ${row.id}`);
    for (const [id, saved] of Object.entries(row.checks)) {
      const answer = body.answers[id] ?? fail(`response omitted ${id}`);
      if (saved.predicted !== answer.choice || !isDeepStrictEqual(saved.probabilities, answer.probabilities)) fail(`saved choice differs for ${id} on ${row.id}`);
    }
  }
}

if (process.argv[2] === 'plans') {
  const data = JSON.parse(await text(process.stdin));
  process.stdout.write(JSON.stringify({ items: Object.fromEntries(data.items.map(item => [item.id, requestPlan(data, item)])),
    criteria: reportCriteria(data.criteria), policy: requestPolicyFor(data) }));
}
