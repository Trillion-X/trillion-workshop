// The decision to place a reviewed question in private draft work. All rows must
// come from the account's current store; caller text alone cannot clear evidence.
import { canonical, identityOf } from '../../shared-code/src/record-identity.mjs';
import { yourRecordsStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/your-records.mjs';
import { currentAudienceSource, keepAudienceSource, readAudienceSource, publicSourceUrl, readPublicAudiencePage } from './audience-question-sources.mjs';
import { failureOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/failure.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const keyOf = value => text(value).normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const same = (row, candidate) => row?.venture_ref === candidate.venture_ref;
const fail = reason => ({ admitted: false, reason });
const withdrawPendingWork = (records, candidateId) => {
  for (const work of records.read(['audience-question-work']).filter(row => row.candidate_id === candidateId && row.state === 'pending_draft')) {
    records.write([{ type: 'audience-question-work', id: work.id, value: { ...work, state: 'withdrawn' } }],
      { tool_id: 'audience-question-review' });
  }
  for (const draft of records.read(['audience-answer-draft']).filter(row => row.candidate_id === candidateId && row.state === 'private_draft')) {
    records.write([{ type: 'audience-answer-draft', id: draft.id, value: { ...draft, state: 'needs_review' } }],
      { tool_id: 'audience-question-review' });
  }
};

export function prepareAudienceQuestionAdmission({ candidate, review, evidence = [], answers = [], work = [], sources = [] }) {
  if (!candidate || candidate.kind !== 'audience-question' || !text(candidate.id) || !text(candidate.revision)
      || !text(candidate.venture_ref) || !text(candidate.question_key) || !text(candidate.question)
      || !text(candidate.source_ref) || !text(candidate.offer_ref)
      || candidate.question_key !== keyOf(candidate.question)) return fail('candidate_missing_or_incomplete');
  if (![evidence, answers, work, sources].every(Array.isArray)) return fail('current_rows_required');
  const source = sources.find(row => row?.id === candidate.source_ref);
  if (!source || source.role !== 'question' || !same(source, candidate)
      || source.offer_ref !== candidate.offer_ref || keyOf(source.quote) !== candidate.question_key) return fail('observed_question_required');
  if (!review || review.kind !== 'audience-question-review' || review.candidate_id !== candidate.id
      || review.candidate_revision !== candidate.revision || !same(review, candidate)
      || review.verdict !== 'accepted') return fail('current_acceptance_required');
  if (!Array.isArray(review.evidence_refs) || !review.evidence_refs.length
      || review.evidence_refs.some(ref => !text(ref))
      || new Set(review.evidence_refs).size !== review.evidence_refs.length) return fail('answer_evidence_required');
  if (answers.some(row => same(row, candidate) && row.question_key === candidate.question_key)) return fail('answer_already_exists');
  if (work.some(row => same(row, candidate) && row.question_key === candidate.question_key && row.state !== 'withdrawn')) return fail('work_already_exists');
  const grounding = [];
  for (const ref of review.evidence_refs) {
    const matches = evidence.filter(row => row.id === ref);
    if (matches.length !== 1) return fail('current_evidence_required');
    const row = matches[0];
    const answerSource = sources.find(source => source?.id === row.source_ref);
    const rightsSource = sources.find(source => source?.id === row.rights_basis_ref);
    if (!same(row, candidate) || row.kind !== 'audience-answer-evidence'
        || row.supports_answer !== true || row.rights_status !== 'cleared'
        || !text(row.rights_basis_ref) || !text(row.source_ref) || !text(row.excerpt)
        || !text(row.rights_note) || !text(row.answer_note)
        || row.source_ref === candidate.source_ref
        || !answerSource || answerSource.role !== 'answer' || !same(answerSource, candidate)
        || keyOf(answerSource.quote) !== keyOf(row.excerpt)
        || !rightsSource || rightsSource.role !== 'rights' || !same(rightsSource, candidate)) return fail('answer_evidence_not_usable');
    grounding.push({ evidence_ref: row.id, source_ref: row.source_ref,
      source_url: answerSource.source_url, observed_at: answerSource.observed_at,
      excerpt: row.excerpt, answer_note: row.answer_note,
      rights_basis_ref: row.rights_basis_ref, rights_url: rightsSource.source_url,
      rights_observed_at: rightsSource.observed_at,
      rights_quote: rightsSource.quote, rights_note: row.rights_note });
  }
  const id = `audience-question-work:${identityOf(JSON.stringify([candidate.venture_ref, candidate.question_key]))}`;
  return { admitted: true, work: { kind: 'audience-question-work', id,
    candidate_id: candidate.id, candidate_revision: candidate.revision,
    venture_ref: candidate.venture_ref, question_key: candidate.question_key,
    question: candidate.question, audience: candidate.audience ?? null,
    locale: candidate.locale ?? null, source_ref: candidate.source_ref,
    source_url: source.source_url, source_observed_at: source.observed_at,
    offer_ref: candidate.offer_ref, grounding, state: 'pending_draft' } };
}

// Read every prerequisite from one person's current records, then write and read
// back one private work item. No caller-supplied review or rights verdict is used.
export function admitCurrentAudienceQuestion(eeaf, candidateId) {
  const records = yourRecordsStore(eeaf);
  const [candidates, reviews, evidence, answers, work] = [
    'audience-question', 'audience-question-review', 'audience-answer-evidence',
    'audience-answer', 'audience-question-work',
  ].map(type => records.read([type]));
  const matches = candidates.filter(row => row.id === candidateId);
  if (matches.length !== 1) return fail('candidate_missing_or_conflicting');
  const candidate = matches[0];
  const sourceRefs = [candidate.source_ref, ...evidence.filter(row => row.venture_ref === candidate.venture_ref)
    .flatMap(row => [row.source_ref, row.rights_basis_ref])].filter(Boolean);
  const sources = sourceRefs.map(id => currentAudienceSource(eeaf, id)).filter(Boolean);
  const currentReviews = reviews.filter(row => row.candidate_id === candidateId && row.candidate_revision === candidate.revision);
  if (currentReviews.length !== 1) return fail('current_review_missing_or_conflicting');
  const trustedReview = eeaf.read(`audience-question-decision:${candidateId}`);
  if (!trustedReview || canonical(trustedReview) !== canonical(currentReviews[0])) return fail('current_review_not_verified');
  const decision = prepareAudienceQuestionAdmission({ candidate, review: currentReviews[0], evidence, answers, work, sources });
  if (!decision.admitted) return decision;
  records.write([{ type: 'audience-question-work', id: decision.work.id, value: decision.work }],
    { tool_id: 'audience-question-admission' });
  const readback = records.read(['audience-question-work']).filter(row => row.id === decision.work.id);
  if (readback.length !== 1 || canonical(readback[0]) !== canonical(decision.work)) return fail('work_readback_failed');
  return { admitted: true, work: readback[0] };
}

export function listCurrentAudienceQuestions(eeaf, { venture_ref } = {}) {
  const records = yourRecordsStore(eeaf);
  const candidates = records.read(['audience-question']);
  const reviews = records.read(['audience-question-review']);
  const work = records.read(['audience-question-work']);
  const drafts = records.read(['audience-answer-draft']);
  return candidates.filter(candidate => !venture_ref || candidate.venture_ref === venture_ref).map(candidate => ({
    candidate,
    reviews: reviews.filter(review => review.candidate_id === candidate.id && review.candidate_revision === candidate.revision
      && canonical(review) === canonical(eeaf.read(`audience-question-decision:${candidate.id}`))),
    work: work.filter(item => item.candidate_id === candidate.id),
    drafts: drafts.filter(item => item.candidate_id === candidate.id),
  }));
}

// An answer stays private. The account rechecks the admission decision rather than
// trusting a caller to supply provenance, an offer, or a review verdict.
export function saveCurrentAudienceAnswerDraft(eeaf, { candidate_id, expected_revision = null, answer, destination_url }) {
  const records = yourRecordsStore(eeaf);
  const candidates = records.read(['audience-question']).filter(row => row.id === candidate_id);
  const works = records.read(['audience-question-work']).filter(row => row.candidate_id === candidate_id && row.state === 'pending_draft');
  if (candidates.length !== 1 || works.length !== 1) return { saved: false, reason: 'current_work_required' };
  const candidate = candidates[0];
  const work = works[0];
  if (work.candidate_revision !== candidate.revision || work.venture_ref !== candidate.venture_ref
      || work.offer_ref !== candidate.offer_ref) return { saved: false, reason: 'work_is_stale' };
  const review = eeaf.read(`audience-question-decision:${candidate_id}`);
  const reviewed = records.read(['audience-question-review']).filter(row => row.candidate_id === candidate_id);
  if (reviewed.length !== 1 || canonical(reviewed[0]) !== canonical(review) || review?.verdict !== 'accepted'
      || review.candidate_revision !== candidate.revision) return { saved: false, reason: 'current_review_required' };
  const evidence = records.read(['audience-answer-evidence']);
  const sourceRefs = [candidate.source_ref, ...evidence.filter(row => row.venture_ref === candidate.venture_ref)
    .flatMap(row => [row.source_ref, row.rights_basis_ref])].filter(Boolean);
  const sources = sourceRefs.map(id => currentAudienceSource(eeaf, id)).filter(Boolean);
  const admission = prepareAudienceQuestionAdmission({ candidate, review, evidence,
    answers: records.read(['audience-answer']), work: [], sources });
  if (!admission.admitted || canonical(admission.work) !== canonical(work))
    return { saved: false, reason: 'grounding_or_work_is_stale' };
  if (!text(answer) || !text(destination_url)) return { saved: false, reason: 'answer_and_destination_required' };
  let destination;
  try { destination = publicSourceUrl(destination_url); }
  catch { return { saved: false, reason: 'public_https_destination_required' }; }
  const id = `audience-answer-draft:${candidate_id}`;
  const previous = records.read(['audience-answer-draft']).filter(row => row.id === id);
  if (previous.length > 1 || (previous[0]?.revision ?? null) !== expected_revision)
    return { saved: false, reason: 'draft_changed', current_revision: previous[0]?.revision ?? null };
  const revision = identityOf(JSON.stringify([work.id, candidate.revision, text(answer), destination, expected_revision]));
  const draft = { kind: 'audience-answer-draft', id, revision, candidate_id,
    candidate_revision: candidate.revision, work_id: work.id, venture_ref: work.venture_ref,
    question: work.question, source_ref: work.source_ref, offer_ref: work.offer_ref,
    grounding: work.grounding, answer: text(answer), destination_url: destination,
    state: 'private_draft' };
  records.write([{ type: 'audience-answer-draft', id, value: draft }], { tool_id: 'audience-answer-draft' });
  const saved = records.read(['audience-answer-draft']).find(row => row.id === id);
  return canonical(saved) === canonical(draft) ? { saved: true, draft: saved }
    : { saved: false, reason: 'draft_readback_failed' };
}

// The same account operations serve the person's screen and their AI. A question
// starts from a quote this service saw on a public page, never a free-text row.
export function keepObservedAudienceQuestion(eeaf, sourceId, { audience = null, locale = null } = {}) {
  const source = currentAudienceSource(eeaf, sourceId);
  if (!source || source.role !== 'question' || !text(source.offer_ref)) return fail('observed_question_required');
  const question_key = keyOf(source.quote);
  const id = `audience-question:${identityOf(JSON.stringify([source.venture_ref, question_key]))}`;
  const candidate = { kind: 'audience-question', id,
    revision: identityOf(JSON.stringify([source.id, source.quote, audience, locale])),
    venture_ref: source.venture_ref, question: source.quote, question_key,
    source_ref: source.id, offer_ref: source.offer_ref, audience, locale };
  const records = yourRecordsStore(eeaf);
  const old = records.read(['audience-question']).find(row => row.id === id);
  if (old && canonical(old) !== canonical(candidate)) withdrawPendingWork(records, id);
  records.write([{ type: 'audience-question', id, value: candidate }], { tool_id: 'audience-question-intake' });
  return { kept: true, candidate };
}

export function reviewObservedAudienceQuestion(eeaf, { candidate_id, verdict, reason = '', answer_source_id, rights_source_id, answer_note = '', rights_note = '' }) {
  const records = yourRecordsStore(eeaf);
  const candidates = records.read(['audience-question']).filter(row => row.id === candidate_id);
  if (candidates.length !== 1) return fail('candidate_missing_or_conflicting');
  const candidate = candidates[0];
  if (!['accepted', 'rejected'].includes(verdict)) return fail('review_verdict_required');
  if (verdict === 'rejected' && !text(reason)) return fail('rejection_reason_required');
  const evidence_refs = [];
  if (verdict === 'accepted') {
    const answer = currentAudienceSource(eeaf, answer_source_id);
    const rights = currentAudienceSource(eeaf, rights_source_id);
    if (!answer || !rights || answer.role !== 'answer' || rights.role !== 'rights'
        || !same(answer, candidate) || !same(rights, candidate) || !text(answer_note) || !text(rights_note)) return fail('answer_and_rights_evidence_required');
    if (new URL(answer.source_url).hostname !== new URL(rights.source_url).hostname) return fail('rights_source_must_cover_answer_site');
    const id = `audience-answer-evidence:${identityOf(JSON.stringify([candidate.id, answer.id, rights.id, text(answer_note), text(rights_note)]))}`;
    records.write([{ type: 'audience-answer-evidence', id, value: {
      kind: 'audience-answer-evidence', id, venture_ref: candidate.venture_ref,
      source_ref: answer.id, excerpt: answer.quote, rights_status: 'cleared',
      rights_basis_ref: rights.id, rights_note: text(rights_note), answer_note: text(answer_note), supports_answer: true,
    } }], { tool_id: 'audience-question-review' });
    evidence_refs.push(id);
  }
  const review = { kind: 'audience-question-review', candidate_id: candidate.id,
    candidate_revision: candidate.revision, venture_ref: candidate.venture_ref,
    verdict, evidence_refs, ...(verdict === 'rejected' ? { reason: text(reason) } : {}) };
  const oldReview = records.read(['audience-question-review']).find(row => row.candidate_id === candidate.id);
  if (oldReview && canonical(oldReview) !== canonical(review)) withdrawPendingWork(records, candidate.id);
  records.write([{ type: 'audience-question-review', id: candidate.id, value: review }],
    { tool_id: 'audience-question-review' });
  eeaf.write([{ id: `audience-question-decision:${candidate.id}`, type: 'audience-question-decision', value: review }],
    { actor: { by: 'audience-question-review' } });
  if (verdict === 'rejected') withdrawPendingWork(records, candidate.id);
  return { reviewed: true, review };
}

// The Audience questions screen and its MCP tools over one account's own records (audience-questions:request in
// src/native-owner-routes.json). An account whose plan keeps no work reads an empty screen and has each write refused
// with the reason, as before; the plan is read again for every request (keeps()).
// Each write is one synchronous write, committed with its answer through `commit` (kept under the command's receipt,
// src/standalone-resource-behavior.mjs routeReceipts); a plan that keeps no work writes nothing.
export const AUDIENCE_QUESTION_RECEIPTED_WRITES = Object.freeze(['audience-questions:observe', 'audience-questions:keep', 'audience-questions:review', 'audience-questions:admit', 'audience-questions:draft']);
export function audienceQuestionOwner({ eeaf, keeps, readPage = readPublicAudiencePage, commit = change => change() }) {
  const refused = field => ({ [field]: false, reason: 'account_does_not_keep_work' });
  return {
    async screen() {
      if (!await keeps()) return { questions: [], sources: [], upgrade_needed: true };
      return { questions: listCurrentAudienceQuestions(eeaf), sources: eeaf.ids('audience-source').map(id => eeaf.read(id)).filter(Boolean) };
    },
    async observe(input) {
      if (!await keeps()) return refused('observed');
      const source = await readAudienceSource(input, { readPage });
      return commit(() => ({ observed: true, source: keepAudienceSource(eeaf, source) }), { operation: 'audience-questions:observe' });
    },
    async keep(input) { return await keeps() ? commit(() => keepObservedAudienceQuestion(eeaf, input.source_id, input), { operation: 'audience-questions:keep' }) : refused('kept'); },
    async review(input) { return await keeps() ? commit(() => reviewObservedAudienceQuestion(eeaf, input), { operation: 'audience-questions:review' }) : refused('reviewed'); },
    async admit(input) { return await keeps() ? commit(() => admitCurrentAudienceQuestion(eeaf, String(input.candidate_id ?? '')), { operation: 'audience-questions:admit' }) : refused('admitted'); },
    async draft(input) { return await keeps() ? commit(() => saveCurrentAudienceAnswerDraft(eeaf, input), { operation: 'audience-questions:draft' }) : refused('saved'); },
  };
}

const AUDIENCE_QUESTION_WRITES = new Set(['observe', 'keep', 'review', 'admit', 'draft']);

export async function handleAudienceQuestionRequest(owner, request) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/audience-questions' && request.method === 'GET') return Response.json(await owner.screen());
    const write = path.slice('/audience-questions/'.length);
    if (request.method !== 'POST' || !path.startsWith('/audience-questions/') || !AUDIENCE_QUESTION_WRITES.has(write)) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(await owner[write](await request.json()));
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}
