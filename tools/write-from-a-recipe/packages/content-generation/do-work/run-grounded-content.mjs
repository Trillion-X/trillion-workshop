// Keep model review outside the workflow lane. A calibrated judge asks
// model-response, which itself invokes workflow; doing that from a workflow
// step deadlocks the lane that must answer the nested request.
import {composeRunRequest} from './process-scripts/compose-run-request-lib.mjs';
import {evaluateGate, buildOwnerDelivery} from './process-scripts/gate-and-build-owner-delivery-lib.mjs';
import {RequiredVerdictRejectedError, reviewRequiredVerdicts} from './review-required-verdicts.mjs';

function decoded(reply) {
  let value = reply?.payload ?? reply;
  if (value instanceof Uint8Array) value = JSON.parse(new TextDecoder().decode(value));
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
}

function sourceText(row, retrieval) {
  const blocks = row?.payload?.[retrieval.text_blocks_array];
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('Current source has no declared text blocks');
  const path = retrieval.text_block_path;
  if (!Array.isArray(path) || path.length === 0) throw new Error('Recipe must declare a source text path');
  const childrenPath = retrieval.text_block_children_path ?? ['children'];
  if (!Array.isArray(childrenPath) || childrenPath.length === 0) {
    throw new Error('Recipe must declare a source text block children path');
  }
  const texts = [];
  const visit = (items) => {
    for (const block of items) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const text = path.reduce((value, key) => value?.[key], block);
      if (typeof text === 'string' && text.trim()) texts.push(text);
      const children = childrenPath.reduce((value, key) => value?.[key], block);
      if (Array.isArray(children)) visit(children);
    }
  };
  visit(blocks);
  return texts.join('\n');
}

function addressOf(ref) {
  const value = typeof ref === 'string' ? ref : ref?.canonical_address ?? ref?.address;
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) throw new Error('A canonical source address is required');
  return value;
}

async function callWorkflow(send, definition_id, input) {
  const reply = decoded(await send({target:'slot::workflow',payload:{
    operation:'execute_definition', definition_id, input,
    include_output:true, include_steps:false,
  }}));
  if (reply?.status !== 'completed') throw new Error(`${definition_id} did not complete: ${reply?.status ?? 'no status'}`);
  return reply.output;
}

export async function runGroundedContent(input, _context, dependencies = {}) {
  const recipe = input?.recipe, workItem = input?.work_item;
  if (!recipe || !workItem || typeof input.request_id !== 'string' || !input.request_id.trim()) {
    throw new Error('Recipe, work item and request identity are required');
  }
  const refs = workItem[recipe.context_retrieval?.input_refs_field];
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > 16) throw new Error('Current source references are required');
  const addresses = refs.map(addressOf);
  if (new Set(addresses).size !== addresses.length) throw new Error('Source references must be unique');
  const send = dependencies.send ?? (await import('@bitfield/runtime-kit')).sendRequestToBitfieldTarget;
  const sourceReply = decoded(await send({target:'slot::find-current-items',payload:{
    operation:'find-current-items', in:'published-record', addresses,
    include:['address','content_hash','payload'],
  }}));
  const rows = sourceReply?.items;
  if (!Array.isArray(rows) || rows.length !== addresses.length) throw new Error('Each source must resolve to one current document');
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  const supplied = input.grounding;
  if (!Array.isArray(supplied) || supplied.length !== addresses.length) throw new Error('Grounding must name each source');
  const grounding = addresses.map((address, index) => {
    const row = byAddress.get(address), text = sourceText(row, recipe.context_retrieval);
    if (!row?.content_hash || !text || supplied[index]?.text !== text || typeof supplied[index]?.ref !== 'string') {
      throw new Error('Grounding must match the current source document exactly');
    }
    return {ref:supplied[index].ref, text, source_address:address, source_content_hash:row.content_hash};
  });
  const blocksReply = decoded(await send({target:'slot::find-current-items',payload:{
    operation:'find-current-items', in:'published-record',
    where:{all:[{field:'kind',in:['ai-instruction-block']}]},
  }}));
  const request = composeRunRequest({recipe,workItem,grounding,blocks:blocksReply?.items ?? [],requestId:input.request_id});
  if (input.agent_ref) request.agent_ref = input.agent_ref;
  if (input.model) request.model = input.model;
  const produced = await callWorkflow(send,'action:run-ai-records-production',request);
  const item = produced?.items?.[0];
  if (produced?.error_code || !item || typeof item !== 'object') throw new Error(`Producer did not return one item: ${produced?.error_code ?? 'missing item'}`);
  const policy = recipe.gate_policy ?? {};
  let review;
  try {
    review = await reviewRequiredVerdicts({
      required_verdicts:policy.required_verdicts ?? [], produced_item:item, grounding,
      providers:policy.verdict_providers, passes:policy.verdict_passes,
    },null,dependencies.judge);
  } catch (error) {
    if (!(error instanceof RequiredVerdictRejectedError)) throw error;
    return {
      accepted:false,
      produced_item:item,
      rejected_verdict_id:error.rejected_id,
      verdicts:error.verdicts,
      source_content_hashes:grounding.map(({source_address,source_content_hash})=>({source_address,source_content_hash})),
    };
  }
  if (review.accepted !== true) throw new Error('Semantic review did not accept the draft');
  const [passed,code,reason] = evaluateGate(item,policy,grounding);
  if (!passed) throw new Error(`Content gate rejected: ${code}: ${reason}`);
  const [deliverable,delivery,deliveryError] = buildOwnerDelivery(item,workItem,input.context ?? {},recipe.delivery_target);
  if (!deliverable) throw new Error(`Owner delivery rejected: ${deliveryError}`);
  await callWorkflow(send,delivery.definition_id,delivery.input);
  const docId = delivery.input.doc_id;
  if (typeof docId !== 'string' || !docId) throw new Error('Owner delivery omitted document identity');
  const saved = decoded(await send({target:'engine.operation.label-addressed',payload:{
    operation_label:'engine.operation.read-current',address_label:`package::documents::documents::${docId}`,
    address_mode:'identity_text',
  }}));
  if (saved?.found !== true) throw new Error('Document owner did not save the reviewed draft');
  return {accepted:true,doc_id:docId,document_content_hash:saved.content_hash,
    verdicts:review.verdicts.map(({id,accepted})=>({id,accepted})),
    source_content_hashes:grounding.map(({source_address,source_content_hash})=>({source_address,source_content_hash}))};
}

export const run = runGroundedContent;
