import { composePublicSalesPageCandidate } from './compose-public-sales-page.mjs';

function unpack(reply) {
  let value = reply;
  if (value?.payload instanceof Uint8Array) value = JSON.parse(new TextDecoder().decode(value.payload));
  else if (Array.isArray(value?.payload)) value = JSON.parse(new TextDecoder().decode(Uint8Array.from(value.payload)));
  else if (typeof value?.payload === 'string') value = JSON.parse(value.payload);
  else if (value?.payload && value.found === undefined && (value.payload.found !== undefined || value.payload.items || value.payload.accepted !== undefined)) value = value.payload;
  return value;
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function textNodes(nodes, output = []) {
  for (const node of nodes ?? []) {
    if (node.visible === false) continue;
    if (node.kind === 'Text' && typeof node.props?.text === 'string') output.push(node);
    textNodes(node.children, output);
  }
  return output;
}

/** Read-only candidate preparation. All policy and source bytes are read through
 * current owner operations; client input can name a document, never a verdict.
 * Publication still requires review of the resulting rendered page.
 */
export async function prepareCurrentDocument(input, context, dependencies = {}) {
  if (!plain(input) || Object.keys(input).some(key => key !== 'document_ref') ||
      !/^package::documents::documents::[^\s]+$/.test(input.document_ref ?? '')) {
    throw new Error('Only a canonical document_ref is accepted.');
  }
  // The caller hands in its engine sender. The old Bitfield runtime default is retired.
  const send = dependencies.send;
  if (typeof send !== 'function') throw new Error('Preparing a publication needs its engine sender.');
  const bases = [];
  async function read(ref) {
    if (!plain(ref) || typeof ref.address !== 'string' || !['identity_text', 'label_hash'].includes(ref.mode)) {
      throw new Error('Publication configuration contains an invalid owner reference.');
    }
    const row = unpack(await send({target:'engine.operation.label-addressed', payload:{
      operation_label:'engine.operation.read-current', address_label:ref.address, address_mode:ref.mode,
    }}));
    if (row?.found !== true || !row.content_hash || !plain(row.payload)) throw new Error(`Current record is unavailable: ${ref.address}`);
    bases.push({ref, content_hash:row.content_hash});
    return row.payload;
  }
  const config = await read({address:'package::public-document-site::publication-config::default', mode:'label_hash'});
  if (config.kind !== 'public-document-publication-config') throw new Error('Publication configuration kind is invalid.');
  const composition = await read(config.composition_ref);
  const destination = await read(config.destination_ref);
  const policy = await read(config.policy_ref);
  const body = await read({address:input.document_ref, mode:'identity_text'});
  const documentHash = bases.at(-1).content_hash;
  const refs = [...new Set(textNodes(body.children).flatMap(n => n.props?.custom?.source_refs ?? []))];
  if (refs.length === 0 || refs.length > 16 || refs.some(ref => typeof ref !== 'string' || !ref)) {
    throw new Error('Document requires current addressed source references.');
  }
  const grounding = [];
  for (const ref of refs) {
    const matches = (config.source_documents ?? []).filter(row => row.citation_ref === ref);
    if (matches.length !== 1 || !matches[0].document_ref?.address?.startsWith('package::documents::documents::')) {
      throw new Error(`Citation has no unique Documents source: ${ref}`);
    }
    const source = await read(matches[0].document_ref);
    const text = textNodes(source.children).map(n => n.props.text).join('\n');
    if (!text) throw new Error('A cited source has no current text.');
    const excerpt = matches[0].preview_excerpt;
    if (excerpt !== undefined && (typeof excerpt !== 'string' || !excerpt.trim() || !text.includes(excerpt))) {
      throw new Error('A source preview excerpt must occur verbatim in the current source.');
    }
    grounding.push({ref,text,...(excerpt ? {excerpt} : {}),title:matches[0].title ?? ref,media:matches[0].media ?? {},content_hash:bases.at(-1).content_hash});
  }
  const candidate = composePublicSalesPageCandidate({snapshot:{document_ref:input.document_ref,
    document_revision_hash:documentHash,body}, composition,destination,sources:grounding});
  const gate = policy.gate_policy;
  const required = gate?.required_verdicts;
  if (!Array.isArray(required) || required.length < 2) throw new Error('Current publication policy requires factual and writing reviews.');
  if (!['factual','writing'].every(role=>required.filter(review=>review.role===role).length===1)
      || new Set(required.map(review=>review.id)).size !== required.length) {
    throw new Error('Current publication policy must have distinct factual and writing reviews.');
  }
  const verdicts = [];
  for (const review of required) {
    if (review.target !== 'ask-a-small-model-for-a-verdict.judge-content' || !review.id || !plain(review.rubric)) {
      throw new Error('Current publication policy has an invalid review.');
    }
    const result = unpack(await send({target:review.target,payload:{rubric:review.rubric,
      content:JSON.stringify({supplied_grounding:grounding,produced_item:candidate.page}),
      providers:gate.verdict_providers,passes:gate.verdict_passes}}));
    if (result?.accepted !== true || (Object.hasOwn(result,'findings') &&
        (!Array.isArray(result.findings) || result.findings.some(f => f?.resolved !== true)))) {
      throw new Error(`Required review did not accept the page: ${review.id}`);
    }
    verdicts.push({id:review.id,role:review.role,verdict:result});
  }
  // Re-read all mutable inputs after the real model calls. A changed policy is
  // as invalidating as an edit to the document or its source material.
  const reviewedBases = [...bases];
  for (const base of reviewedBases) {
    await read(base.ref);
    if (bases.at(-1).content_hash !== base.content_hash) throw new Error(`Publication input changed during review: ${base.ref.address}`);
  }
  return {...candidate, state:'render-review-required',input_bases:reviewedBases,
    source_bases:grounding.map(({ref,content_hash})=>({ref,content_hash})),verdicts,
    publication:{write_allowed:false,review_state:'render-review-required'}};
}

export const run = prepareCurrentDocument;
