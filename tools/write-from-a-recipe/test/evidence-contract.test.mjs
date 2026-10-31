import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { checkWritingAgainstItsRecipe } from '../do-work/check-writing-against-its-recipe.mjs';
import { evidenceReviewBinding } from '../read-data/evidence-contract.mjs';

const identity = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
const utf8Length = text => new TextEncoder().encode(text).length;

function validInput() {
  const sourceText = 'Study result: three teams observed a limited result.';
  const draftText = 'Three teams observed a limited result.';
  const claim = {
    ref: 'claim:teams-observed', version_id: 'claim-version:1', text: 'Three teams observed a limited result.',
    scope: { population: 'three teams', setting: 'one trial', duration: 'one week', limitation: 'not product scale evidence' },
    source_refs: ['source:study:edition-2'],
  };
  const packet = {
    schema: 'source-backed-claims/v1',
    sources: [{
      ref: 'source:study:edition-2', edition_id: 'edition:2', origin_ref: 'origin:study', source_text: sourceText,
      content_identity: identity(sourceText), rights: { access: 'private', may_quote: false, may_reveal_identity: false, grant_ref: 'grant:opaque' },
    }],
    claims: [{
      ref: claim.ref, version_id: claim.version_id, text: claim.text, scope: claim.scope,
      evidence_refs: [{
        source_ref: 'source:study:edition-2', edition_id: 'edition:2', content_identity: identity(sourceText), relation: 'supports',
        quote: {
          ref: 'quote:one', source_start_byte: 0, source_end_byte: utf8Length(sourceText), source_literal: sourceText,
          destination_start_byte: 0, destination_end_byte: utf8Length(draftText), destination_literal: draftText,
        },
      }],
    }],
  };
  const writing = { title: 'A qualified result', draft_text: draftText, claims: [claim] };
  const policy = {
    evidence_contract: 'source-backed-claims/v1',
    required_verdicts: [{ id: 'entailment-and-scope' }, { id: 'counterevidence-and-alternatives' }],
  };
  const binding = evidenceReviewBinding({ evidence_packet: packet, writing });
  const stableClaimIdentity = identity('{"ref":"claim:teams-observed","scope":{"duration":"one week","limitation":"not product scale evidence","population":"three teams","setting":"one trial"},"text":"Three teams observed a limited result.","version_id":"claim-version:1"}');
  const review = {
    accepted: true,
    attribution: { reviewer_ref: 'reviewer:analyst-7', method: 'independent semantic read of packet and draft' },
    binding,
    verdicts: ['entailment-and-scope', 'counterevidence-and-alternatives'].map(id => ({
      id, accepted: true, claim_ref: claim.ref, claim_version_id: claim.version_id,
      claim_identity: stableClaimIdentity,
      scope_identity: identity('{"duration":"one week","limitation":"not product scale evidence","population":"three teams","setting":"one trial"}'),
      ...binding, rationale: 'The sentence stays within the named population and time limit.',
    })),
  };
  return { recipe: { gate_policy: policy }, evidence_packet: packet, writing, review };
}

test('strict source-backed claims pass with exact editions, current draft and scoped attributed review', () => {
  const input = validInput();
  const result = checkWritingAgainstItsRecipe(input);
  assert.equal(result.passed, true, result.reason);
  assert.equal(result.evidence_review.assurance, 'caller_attributed_unverified');
  assert.equal(result.evidence_review.rights, 'metadata_preserved_not_authorized');
});

test('a missing review returns exact per-claim identities needed for review', () => {
  const input = validInput();
  delete input.review;
  const result = checkWritingAgainstItsRecipe(input);
  assert.equal(result.reject_code, 'evidence_contract_failed');
  assert.equal(result.review_binding.claims[0].claim_ref, input.writing.claims[0].ref);
  assert.equal(result.review_binding.claims[0].claim_version_id, input.writing.claims[0].version_id);
  assert.match(result.review_binding.claims[0].claim_identity, /^1f:[a-f0-9]{64}$/);
});

test('correct source quote cannot make a semantic reviewer accept an overbroad claim', () => {
  const input = validInput();
  input.writing.draft_text = 'This proves the product works at enterprise scale.';
  input.writing.claims[0].text = input.writing.draft_text;
  input.evidence_packet.claims[0].text = input.writing.draft_text;
  input.evidence_packet.claims[0].evidence_refs[0].quote.destination_literal = input.writing.draft_text;
  input.evidence_packet.claims[0].evidence_refs[0].quote.destination_end_byte = utf8Length(input.writing.draft_text);
  const current = evidenceReviewBinding(input);
  input.review.binding = current;
  const falseClaimIdentity = identity('{"ref":"claim:teams-observed","scope":{"duration":"one week","limitation":"not product scale evidence","population":"three teams","setting":"one trial"},"text":"This proves the product works at enterprise scale.","version_id":"claim-version:1"}');
  for (const verdict of input.review.verdicts) {
    Object.assign(verdict, current, { claim_identity: falseClaimIdentity, accepted: false, rationale: 'One small trial cannot support a product scale claim.' });
  }
  assert.match(checkWritingAgainstItsRecipe(input).reason, /semantic_review_verdict_rejected/);
});

test('changed review binding, draft, and source edition fail closed', () => {
  const staleReview = validInput();
  staleReview.review.binding.draft_identity = '1f:stale';
  assert.match(checkWritingAgainstItsRecipe(staleReview).reason, /stale_semantic_review/);

  const changedDraft = validInput();
  changedDraft.writing.draft_text += ' New sentence.';
  assert.match(checkWritingAgainstItsRecipe(changedDraft).reason, /stale_semantic_review/);

  const changedSource = validInput();
  changedSource.evidence_packet.sources[0].source_text += ' Changed.';
  assert.match(checkWritingAgainstItsRecipe(changedSource).reason, /source_content_identity_mismatch/);
});

test('duplicate source origin cannot be counted as independent evidence', () => {
  const input = validInput();
  input.evidence_packet.sources.push({ ...input.evidence_packet.sources[0], ref: 'source:copy', edition_id: 'edition:copy' });
  const quote = structuredClone(input.evidence_packet.claims[0].evidence_refs[0]);
  quote.source_ref = 'source:copy';
  quote.edition_id = 'edition:copy';
  input.evidence_packet.claims[0].evidence_refs.push(quote);
  input.writing.claims[0].source_refs.push('source:copy');
  assert.match(checkWritingAgainstItsRecipe(input).reason, /duplicate_source_origin/);
});

test('incorrect quote bytes and unsafe public text do not pass mechanical evidence checks', () => {
  const changedQuote = validInput();
  changedQuote.evidence_packet.claims[0].evidence_refs[0].quote.source_literal = 'A different quote';
  assert.match(checkWritingAgainstItsRecipe(changedQuote).reason, /source_span_check_failed/);

  const unsafeText = validInput();
  unsafeText.writing.draft_text = '<script>alert(1)</script>';
  assert.match(checkWritingAgainstItsRecipe(unsafeText).reason, /unsafe_public_text/);
});

test('rights metadata is retained as metadata and does not claim to authorize publication', () => {
  const input = validInput();
  const result = checkWritingAgainstItsRecipe(input);
  assert.equal(result.passed, true);
  assert.equal(result.evidence_review.rights, 'metadata_preserved_not_authorized');
  assert.equal('publication_authorized' in result.evidence_review, false);
});

test('strict delivery carries only rights/provenance metadata to its owner', () => {
  const input = validInput();
  input.recipe.delivery_target = {
    tool_id: 'tool:save-a-draft',
    input: {
      draft: { from: 'item', field: 'draft_text' },
      evidence_provenance: { from: 'context', field: 'evidence_provenance' },
    },
  };
  const result = checkWritingAgainstItsRecipe(input);
  assert.equal(result.passed, true, result.reason);
  const provenance = result.delivery.input.evidence_provenance;
  assert.equal(provenance.sources[0].rights.may_quote, false);
  assert.equal('source_text' in provenance.sources[0], false);
  assert.equal('quote' in provenance.claims[0].evidence_refs[0], false);

  delete input.recipe.delivery_target.input.evidence_provenance;
  assert.equal(checkWritingAgainstItsRecipe(input).reject_code, 'evidence_provenance_handoff_missing');
});
