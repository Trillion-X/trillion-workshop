import {readTrustedRuntimePartition, sendRequestToBitfieldTarget, type BitfieldRuntimeContext} from '@bitfield/runtime-kit';
import {buildEngineReadCurrentRequestFromLabels, buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply, makeHashCodeHexFromBytes, makeIdentityTextAddressFromLabel} from '@bitfield/runtime-kit/protocol';
import {inspectOwnerDelivery} from './inspect-owner-delivery';

type Json = Record<string, any>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = /^1f:[0-9a-f]{64}$/;
function object(value: unknown): value is Json {return !!value && typeof value === 'object' && !Array.isArray(value);}
function exact(a: unknown,b: unknown): boolean {
  if (Object.is(a,b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a)!==Array.isArray(b)) return false;
  const keys=Object.keys(a).sort(), other=Object.keys(b).sort();
  return keys.length===other.length && keys.every((key,i)=>key===other[i] && exact((a as Json)[key],(b as Json)[key]));
}
function decoded(reply: unknown): Json {
  if (object(reply) && !('payload' in reply)) return reply;
  const payload=object(reply) && 'payload' in reply ? reply.payload : reply;
  const bytes=ArrayBuffer.isView(payload) ? new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength)
    : payload instanceof ArrayBuffer ? new Uint8Array(payload) : null;
  if (!bytes) throw new Error('The saved result could not be checked.');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if (!object(value)) throw new Error('The saved result is invalid.');
  return value;
}

/** Either durable half can arrive first. The native terminal record itself is
 * pending correlation evidence; receipt publication wakes this same join. */
export async function continueFromTerminal(input:{request_hash:string},context?:BitfieldRuntimeContext,sender=sendRequestToBitfieldTarget) {
  readTrustedRuntimePartition(context);
  if ((context as any)?.runtime?.caller?.local_command_list_admitted !== true) throw new Error('This work needs a verified local app session.');
  if (!hash.test(input?.request_hash??'')) throw new Error('The execution reference is invalid.');
  const result=decoded(await sender({target:'slot::find-current-items',payload:{operation:'find-current-items',
    in:'path',path_labels:['current-item','trigger-dispatch-outcome'],
    where:{all:[{field:'delivery_receipt',eq:{kind:'send-later-request',request_hash:input.request_hash}},
      {field:'rule_id',eq:'trigger:content-generation:dispatch-durable-request'}]},
    include:['payload'],limit:2}}));
  if (!Array.isArray(result.items)) throw new Error('Execution references could not be read.');
  if (result.items.length===0) {
    const address=`send-later::outcome::${input.request_hash}`;
    const reply=await sender(buildEngineReadCurrentRequestFromLabels(readTrustedRuntimePartition(context),address,{addressMode:'label-hash'}));
    const payload=object(reply)&&'payload' in reply ? reply.payload : reply;
    const bytes=ArrayBuffer.isView(payload)?new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength)
      :payload instanceof ArrayBuffer?new Uint8Array(payload):null;
    if (!bytes) throw new Error('The pending execution could not be read.');
    const current=decodeEngineReadCurrentReply(bytes);
    if (!current.found) return {status:'pending',outcome_complete:false};
    const terminal=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(current.payload));
    if (!object(terminal)||terminal.kind!=='send-later-outcome'||terminal.request_hash!==input.request_hash
      ||terminal.attempt!==1||!['succeeded','failed'].includes(terminal.status)
      ||!(terminal.error===null||typeof terminal.error==='string')) throw new Error('The pending execution is invalid.');
    return {status:'pending',outcome_complete:false,pending_correlation_ref:{address,address_mode:'label-hash',
      content_hash:makeHashCodeHexFromBytes(current.payload)}};
  }
  if (result.items.length!==1) throw new Error('The execution reference is ambiguous.');
  const row=result.items[0]?.payload;
  if (!object(row)||row.delivery_receipt?.request_hash!==input.request_hash
    ||row.rule_id!=='trigger:content-generation:dispatch-durable-request'
    ||row.status!=='accepted'||row.attempt!==1||!hash.test(row.attempt_ref??'')
    ||typeof row.envelope?.address_text!=='string') throw new Error('The execution reference is invalid.');
  return continueVerifiedOwnerDelivery({request_ref:row.envelope.address_text,
    dispatch_outcome_ref:`trigger-engine.dispatch-outcome::${row.rule_id}::${row.attempt_ref}::${row.attempt}::${row.status}`},context,sender);
}

/** Existing run ledger and dispatch queue are committed together; no new scheduler. */
export async function continueVerifiedOwnerDelivery(input: {request_ref:string;dispatch_outcome_ref:string},
  context?:BitfieldRuntimeContext,sender=sendRequestToBitfieldTarget) {
  const partition=readTrustedRuntimePartition(context);
  if ((context as any)?.runtime?.caller?.local_command_list_admitted !== true) {
    throw new Error('This work needs a verified local app session.');
  }
  const inspected=await inspectOwnerDelivery(input,context,sender);
  if (inspected.status!=='executed') return inspected;
  async function read(address:string,mode:'identity-text'|'label-hash'='identity-text') {
    const reply=await sender(buildEngineReadCurrentRequestFromLabels(partition,address,{addressMode:mode}));
    const payload=object(reply)&&'payload' in reply ? reply.payload : reply;
    const bytes=ArrayBuffer.isView(payload)?new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength)
      :payload instanceof ArrayBuffer?new Uint8Array(payload):null;
    if (!bytes) throw new Error('The current work record could not be read.');
    const current=decodeEngineReadCurrentReply(bytes);
    if (!current.found) return {address,mode,current,value:null,content_hash:null};
    if (!current.payloadHash) throw new Error('The work record has no safe update basis.');
    return {address,mode,current,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(current.payload)),content_hash:makeHashCodeHexFromBytes(current.payload)};
  }
  const bases=[];
  for (const ref of inspected.evidence_refs!) {
    const row=await read(ref.address,ref.address_mode as 'identity-text'|'label-hash');
    if (row.content_hash!==ref.content_hash) throw new Error('The work changed before completion.');
    bases.push(row);
  }
  const original=bases[0].value;
  const plan=original?.verified_continuation;
  if (!object(plan)||!object(plan.verifier)||!object(plan.successor)
    ||typeof plan.verifier.target!=='string'||!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(plan.verifier.target)
    ||!object(plan.verifier.input)||typeof plan.verifier.expected_input_field!=='string'
    ||!object(plan.successor.input)||typeof plan.successor.definition_id!=='string'||!plan.successor.definition_id.trim()
    ||typeof plan.successor.feedback_field!=='string'
    ||[plan.verifier.expected_input_field,plan.successor.feedback_field].some(field=>!field.trim()||['__proto__','constructor','prototype'].includes(field))) {
    throw new Error('This work has no valid saved-result continuation.');
  }
  const verification=decoded(await sender({target:plan.verifier.target,payload:{...plan.verifier.input,
    [plan.verifier.expected_input_field]:original.input}}));
  // The configured verifier owns meaning. This owner only accepts its explicit
  // positive decision with exact current result refs and atomically fences them.
  if (verification.verified!==true) throw new Error('The saved result has not been verified.');
  const refs=Array.isArray(verification.result_refs)?verification.result_refs
    :Array.isArray(plan.verifier.result_ref_fields)?plan.verifier.result_ref_fields.map((field:unknown)=>
      typeof field==='string'&&Object.hasOwn(verification,field)?verification[field]:null):[];
  if (!refs.length||refs.length>16||refs.some(ref=>!object(ref)||typeof ref.address!=='string'||!hash.test(ref.content_hash??''))
    ||new Set(refs.map(ref=>ref.address)).size!==refs.length) throw new Error('The saved result has no exact record references.');
  for (const ref of refs) {
    const row=await read(ref.address);
    if (row.content_hash!==ref.content_hash) throw new Error('The saved result changed before completion.');
    bases.push(row);
  }
  const proofRef=`content-generation.run::${original.request_id}`;
  const successorId=`continuation::${original.request_id}`;
  const successorRef=`content-generation.dispatch-request::${successorId}`;
  const proof={kind:'content-generation.run',id:original.request_id,status:'completed',verified:true,
    original_request_ref:input.request_ref,execution_evidence_refs:inspected.evidence_refs,
    result_refs:refs.map(({address,content_hash}:Json)=>({address,content_hash})),successor_ref:successorRef};
  const successor={kind:'content-generation.dispatch-request',id:successorId,request_id:successorId,idempotency_key:successorId,
    original_request_ref:input.request_ref,verified_result_ref:proofRef,
    definition_id:plan.successor.definition_id,
    input:{...plan.successor.input,[plan.successor.feedback_field]:{result_ref:proofRef,
      result_content_hash:makeHashCodeHexFromBytes(encode(proof)),input_refs:proof.result_refs.map(ref=>({canonical_address:ref.address,expected_content_hash:ref.content_hash}))}},
    lifecycle:{state:'pending',attempt:0,terminal:false}};
  async function replay() {
    const [saved,queued]=await Promise.all([read(proofRef),read(successorRef)]);
    if (!saved.value&&!queued.value) return false;
    if (!exact(saved.value,proof)||!exact(queued.value,successor)) throw new Error('The saved continuation conflicts with this work.');
    for (const basis of bases) {
      const current=await read(basis.address,basis.mode);
      if (current.content_hash!==basis.content_hash) throw new Error('The saved result changed during continuation readback.');
    }
    return true;
  }
  if (await replay()) return {outcome_complete:true,status:'completed',result_ref:proofRef,successor_ref:successorRef,replay:true};
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([
      {partitionLabel:partition,addressMultihashHex:makeIdentityTextAddressFromLabel(proofRef),pathLabels:['current-item','published-record'],payloadBytes:encode(proof),expectedCurrent:{payloadHash:null}},
      {partitionLabel:partition,addressMultihashHex:makeIdentityTextAddressFromLabel(successorRef),pathLabels:['current-item','published-record'],payloadBytes:encode(successor),expectedCurrent:{payloadHash:null}},
    ],bases.map(row=>({partitionLabel:partition,...row.mode==='identity-text'
      ?{addressMultihashHex:makeIdentityTextAddressFromLabel(row.address)}:{addressLabel:row.address},expectedCurrent:{payloadHash:row.current.payloadHash!}}))));
  } catch { /* Exact readback handles lost acknowledgement; no blind second write. */ }
  if (!await replay()) throw new Error('The work changed before its continuation could be saved.');
  return {outcome_complete:true,status:'completed',result_ref:proofRef,successor_ref:successorRef,replay:false};
}
