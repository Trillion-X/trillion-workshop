// tools/decide-with-a-method/read-data/share-a-decision.mjs
//
// A decided decision made safe to show strangers (tool:share-a-decision), apart from the other decision tools so only
// the share's row loads the privacy pass and the review identity, which are other tools' public parts
// (tools/learn-from-everyones-results, tools/ask-a-small-model-for-a-verdict).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A decision is kept as shared only after the plain privacy pass finds nothing in the rewrite with the person's
//      own private terms and a re-identification verdict is accepted for exactly that rewrite and rubric.
//   2. Nothing leaves the person's account here: the kept entry is answered with the pool tool to send it to.
import { readFileSync } from 'node:fs';
import { findings, privateTerms, redact, redactAll } from '../../learn-from-everyones-results/read-data/plain-privacy-pass.mjs';
import { contentReviewIdentity } from '../../ask-a-small-model-for-a-verdict/do-work/judge-content.mjs';
import { canonical, decisionId, decisionOrRefuse, keepDecision, refuse, rowsOf, say } from './decisions.mjs';

const { share: SHARE } = JSON.parse(readFileSync(new URL('./decide-with-a-method.json', import.meta.url), 'utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// The decision as its owner saved it, reduced to what a stranger may learn from: the goal, the options, the one
// chosen, why, the next action and how success is measured.
function decisionFacts(record) {
  const label = id => record.input.options.find(option => option.id === id)?.label ?? id;
  return {
    goal: record.input.goal, options: record.input.options.map(option => option.label), chosen: label(record.decision.option_id),
    why: record.decision.reason, next_action: record.decision.next_action, measured_by: record.decision.success_measure,
  };
}

// A rewrite in the shared shape: every declared field present, words or a list of words as declared, nothing else.
function sharedEntryOf(rewrite) {
  const fields = SHARE.entry_fields;
  if (!object(rewrite) || Object.keys(rewrite).some(name => !fields.some(field => field.name === name))) refuse('share_shape');
  for (const field of fields) {
    const value = rewrite[field.name];
    const ok = field.kind === 'list' ? Array.isArray(value) && value.length > 0 && value.every(nonempty) : nonempty(value);
    if (!ok) refuse('share_shape');
  }
  return Object.fromEntries(fields.map(field => [field.name, rewrite[field.name]]));
}

/**
 * tool:share-a-decision. input { decision_id, rewrite?, reidentification? }. A decided decision made safe to show
 * strangers, in three turns of the calling AI. Without a rewrite: the decision's facts with every private term already
 * redacted, and how to rewrite them in general terms. With a rewrite: the plain privacy pass on it with the person's own
 * private terms (their never-publish list rows and the proper names in the decision) must find nothing, then a
 * re-identification verdict from tools/ask-a-small-model-for-a-verdict must be accepted and bound to exactly this
 * rewrite and rubric (`review_binding.input_identity`); without one, the call answers the rubric and content to ask
 * it with. Only then is the entry kept on the decision (`shared`) and answered with the pool tool to send it to.
 */
export async function shareADecision(input, { door }) {
  const id = decisionId(input);
  const record = await decisionOrRefuse(door, id);
  if (!record.decision) refuse('no_decision_yet');
  const facts = decisionFacts(record);
  const neverPublish = (await rowsOf(door, SHARE.never_publish_row)).map(row => row?.[SHARE.never_publish_field]).filter(nonempty);
  const terms = privateTerms({ texts: [facts, record.input.evidence.map(item => item.claim)], neverPublish });
  if (input.rewrite === undefined) {
    return { case_id: id, next: 'rewrite', ai_instructions: [SHARE.rewrite], facts: redactAll(facts, terms), shape: SHARE.entry_fields };
  }
  const entry = sharedEntryOf(input.rewrite);
  const found = findings(entry, terms);
  if (found.length) refuse('share_not_safe', { found: found.slice(0, 5).map(item => redact(item, terms)).join('; ') });
  const review = { rubric: SHARE.reidentification, content: canonical(entry) };
  const identity = contentReviewIdentity(review);
  const verdict = input.reidentification;
  if (!object(verdict) || verdict.accepted !== true || verdict.review_binding?.input_identity !== identity) {
    return { case_id: id, next: 'check', ai_instructions: [say('share_check', { tool: SHARE.check_tool })], check: { tool: SHARE.check_tool, ...review, input_identity: identity } };
  }
  if (record.shared?.review_identity === identity) return { case_id: id, shared: record.shared, send: { tool: SHARE.pool_tool, entry } };
  record.shared = { entry, review_identity: identity, at: new Date().toISOString() };
  await keepDecision(door, record, `share-a-decision:${id}:${identity}`);
  return { case_id: id, shared: record.shared, send: { tool: SHARE.pool_tool, entry } };
}
