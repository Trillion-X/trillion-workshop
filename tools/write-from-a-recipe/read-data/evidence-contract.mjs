// Additive source-backed writing contract for research and public explanations.
// Mechanical checks bind the supplied bytes and review to this exact draft. They do not
// establish that the sources are true, that a reviewer is who they say they are, or that
// rights metadata grants publication permission.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { judge } from '../../judge-words/do-work/judge-words.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const utf8 = value => new TextEncoder().encode(value);
function containsUnsafeMarkup(value) {
  if (typeof value === 'string') return /<\/?[a-z][^>]*>|\bon[a-z]+\s*=|javascript\s*:/i.test(value);
  if (Array.isArray(value)) return value.some(containsUnsafeMarkup);
  if (isObject(value)) return Object.values(value).some(containsUnsafeMarkup);
  return false;
}

// Canonical JSON is used only to bind structured claim/source sets. Draft identity is
// always the identity of the exact UTF-8 `draft_text` bytes supplied by its writer.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const identity = value => makeHashCodeHexFromBytes(utf8(typeof value === 'string' ? value : canonical(value)));
const fail = reason => ({ passed: false, reason });

function uniqueRows(rows, key) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const map = new Map();
  for (const row of rows) {
    if (!isObject(row) || !nonempty(row[key]) || map.has(row[key])) return null;
    map.set(row[key], row);
  }
  return map;
}

function sourceSetIdentity(sources) {
  return identity([...sources].map(({ ref, edition_id, content_identity }) => ({ ref, edition_id, content_identity }))
    .sort((a, b) => a.ref.localeCompare(b.ref)));
}

/** Returns the exact identities a semantic reviewer must assess and bind to the review. */
export function evidenceReviewBinding({ evidence_packet: packet, writing } = {}) {
  if (!isObject(packet) || !isObject(writing) || typeof writing.draft_text !== 'string') return null;
  const claims = uniqueRows(writing.claims, 'ref');
  const sources = uniqueRows(packet.sources, 'ref');
  if (!claims || !sources) return null;
  const claimReviews = [...claims.values()].map(claim => ({
    claim_ref: claim.ref,
    claim_version_id: claim.version_id,
    claim_identity: identity({ ref: claim.ref, version_id: claim.version_id, text: claim.text, scope: claim.scope }),
    scope_identity: identity(claim.scope),
  })).sort((a, b) => a.claim_ref.localeCompare(b.claim_ref));
  const claimIdentities = claimReviews.map(claim => claim.claim_identity).sort();
  return {
    draft_identity: identity(writing.draft_text),
    claim_set_identity: identity(claimIdentities),
    source_set_identity: sourceSetIdentity([...sources.values()]),
    claims: claimReviews,
  };
}

/** Private handoff context; contains provenance/rights metadata, never source bytes or quotes. */
export function evidenceProvenanceForDelivery(packet, binding) {
  return {
    schema: packet.schema,
    binding,
    sources: packet.sources.map(({ ref, edition_id, origin_ref, content_identity, rights }) => ({
      ref, edition_id, origin_ref, content_identity, rights,
    })),
    claims: packet.claims.map(({ ref, version_id, scope, evidence_refs }) => ({
      ref, version_id, scope,
      evidence_refs: evidence_refs.map(({ source_ref, edition_id, content_identity, relation }) => ({ source_ref, edition_id, content_identity, relation })),
    })),
  };
}

/**
 * Validate exact source editions, claim scope, quotes, public draft and semantic review
 * bindings. Reviewer attribution is preserved verbatim as caller-provided attribution;
 * it is never authenticated here.
 */
export function checkEvidenceContract({ evidence_packet: packet, writing, review, required_verdicts = [] } = {}) {
  if (!isObject(packet) || packet.schema !== 'source-backed-claims/v1') return fail('missing_or_unsupported_evidence_packet');
  if (!isObject(writing) || typeof writing.draft_text !== 'string' || !writing.draft_text.trim()) return fail('missing_exact_draft_text');
  if (containsUnsafeMarkup(writing)) return fail('unsafe_public_text_requires_safe_structured_or_markdown_rendering');
  if (!Array.isArray(required_verdicts) || !required_verdicts.length
    || required_verdicts.some(row => !isObject(row) || !nonempty(row.id))
    || new Set(required_verdicts.map(row => row.id)).size !== required_verdicts.length) return fail('evidence_contract_requires_unique_verdict_ids');

  const sources = uniqueRows(packet.sources, 'ref');
  const packetClaims = uniqueRows(packet.claims, 'ref');
  const draftClaims = uniqueRows(writing.claims, 'ref');
  if (!sources || !packetClaims || !draftClaims) return fail('missing_or_duplicate_source_or_claim');
  for (const source of sources.values()) {
    if (!nonempty(source.edition_id) || !nonempty(source.origin_ref) || typeof source.source_text !== 'string'
      || !isObject(source.rights) || !nonempty(source.content_identity)) return fail('incomplete_source_edition');
    if (identity(source.source_text) !== source.content_identity) return fail('source_content_identity_mismatch');
  }

  if (draftClaims.size !== packetClaims.size) return fail('claim_set_mismatch');
  for (const [ref, claim] of draftClaims) {
    const sourceClaim = packetClaims.get(ref);
    if (!sourceClaim || !nonempty(claim.version_id) || claim.version_id !== sourceClaim.version_id
      || typeof claim.text !== 'string' || claim.text !== sourceClaim.text
      || !isObject(claim.scope) || canonical(claim.scope) !== canonical(sourceClaim.scope)
      || !writing.draft_text.includes(claim.text)
      || !Array.isArray(claim.source_refs) || !Array.isArray(sourceClaim.evidence_refs) || !sourceClaim.evidence_refs.length) {
      return fail('claim_version_text_or_scope_mismatch');
    }
    const sourceRefs = new Set();
    const citedOrigins = new Set();
    for (const evidence of sourceClaim.evidence_refs) {
      if (!isObject(evidence) || !nonempty(evidence.source_ref) || sourceRefs.has(evidence.source_ref)
        || !['supports', 'refutes', 'context'].includes(evidence.relation)) return fail('invalid_claim_evidence_reference');
      sourceRefs.add(evidence.source_ref);
      const source = sources.get(evidence.source_ref);
      if (!source || source.edition_id !== evidence.edition_id || source.content_identity !== evidence.content_identity) return fail('source_edition_binding_mismatch');
      if (citedOrigins.has(source.origin_ref)) return fail('duplicate_source_origin');
      citedOrigins.add(source.origin_ref);
      if (!isObject(evidence.quote) || !nonempty(evidence.quote.ref)) return fail('missing_exact_quote_binding');
    }
    if (canonical([...claim.source_refs].sort()) !== canonical([...sourceRefs].sort())) return fail('claim_source_membership_mismatch');
  }

  const binding = evidenceReviewBinding({ evidence_packet: packet, writing });
  if (!binding) return fail('cannot_bind_current_draft');
  const spanProof = {
    source_spans: {
      current_document: { content_identity: binding.draft_identity, destination_text: writing.draft_text },
      sources: [...sources.values()].map(({ ref, content_identity, source_text }) => ({ ref, content_identity, source_text })),
      quotes: [...packetClaims.values()].flatMap(claim => claim.evidence_refs.map(evidence => ({
        ref: `${claim.ref}:${evidence.quote.ref}`,
        source_ref: evidence.source_ref,
        source_content_identity: evidence.content_identity,
        source_start_byte: evidence.quote.source_start_byte,
        source_end_byte: evidence.quote.source_end_byte,
        source_literal: evidence.quote.source_literal,
        destination_start_byte: evidence.quote.destination_start_byte,
        destination_end_byte: evidence.quote.destination_end_byte,
        destination_literal: evidence.quote.destination_literal,
      }))),
    },
  };
  const quoteRefs = spanProof.source_spans.quotes.map(quote => quote.ref);
  if (new Set(quoteRefs).size !== quoteRefs.length) return fail('duplicate_quote_reference');
  const judged = judge({
    rules: [{
      id: 'exact-source-and-draft-spans', says: 'Source and draft spans must match their exact current UTF-8 bytes.',
      evidence: 'source-span-coverage',
      expected_current_document_identity: binding.draft_identity,
      expected_source_identities: Object.fromEntries([...sources.values()].map(source => [source.ref, source.content_identity])),
    }],
    artifact: spanProof,
  });
  if (!judged.passed) return fail(`source_span_check_failed:${judged.findings.map(finding => finding.found).join(',')}`);

  if (!isObject(review) || review.accepted !== true || !isObject(review.attribution)
    || !nonempty(review.attribution.reviewer_ref) || !nonempty(review.attribution.method)
    || review.authenticated === true || !isObject(review.binding)
    || canonical(review.binding) !== canonical(binding) || !Array.isArray(review.verdicts)) return fail('missing_or_stale_semantic_review_binding');
  const expected = [];
  for (const verdict of required_verdicts) for (const claim of [...draftClaims.values()].sort((a, b) => a.ref.localeCompare(b.ref))) {
    expected.push({ id: verdict.id, claim });
  }
  if (review.verdicts.length !== expected.length) return fail('semantic_review_coverage_mismatch');
  for (let i = 0; i < expected.length; i++) {
    const row = review.verdicts[i], { id, claim } = expected[i];
    const claimIdentity = identity({ ref: claim.ref, version_id: claim.version_id, text: claim.text, scope: claim.scope });
    const scopeIdentity = identity(claim.scope);
    if (!isObject(row) || row.id !== id || row.accepted !== true || row.claim_ref !== claim.ref
      || row.claim_version_id !== claim.version_id || row.claim_identity !== claimIdentity
      || row.scope_identity !== scopeIdentity || row.draft_identity !== binding.draft_identity
      || row.claim_set_identity !== binding.claim_set_identity || row.source_set_identity !== binding.source_set_identity
      || !nonempty(row.rationale)) return fail('semantic_review_verdict_rejected_or_stale');
  }
  return {
    passed: true,
    binding,
    review_assurance: 'caller_attributed_unverified',
    rights_assurance: 'metadata_preserved_not_authorized',
  };
}
