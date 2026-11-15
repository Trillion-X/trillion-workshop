import assert from 'node:assert/strict';
import test from 'node:test';
import { createInboundMail } from '../read-data/inbound-mail.mjs';
import { createOwnInbound } from '../read-data/inbound-own-records.mjs';

function setup() {
  const map=new Map(),edge=[],arrivals=[],kept=[],refused=[];
  const env={APP_KV:{async get(k,type){const raw=map.get(k);return raw===undefined?null:type==='json'?JSON.parse(raw):raw;},async put(k,v){map.set(k,v);},async delete(k){map.delete(k);}}};
  const mail={from:{address:'person@example.com'},headers:[{key:'authentication-results',value:'mx.example; dmarc=pass'}],date:'2026-10-01T01:00:00Z',messageId:'one',text:'Exact  mail words',subject:'Subject',attachments:[{filename:'memo.wav',mimeType:'audio/wav',content:Uint8Array.of(7,8,9)}]};
  class ShareInboxError extends Error{}
  const host=createInboundMail({keepStream:async(_env,userId,file)=>kept.push({userId,file}),deliverSiteWorkerEmail:async()=>false,ShareInboxError,keepInEdge:async(...args)=>edge.push(args),storeDown:e=>e?.status>=500,PostalMime:{parse:async()=>mail}});
  const inbox={preflight:async()=>Response.json({preflight:true}),fetch:async request=>{arrivals.push(await request.json());return Response.json({kept:true});}};
  const message=to=>({to,from:'person@example.com',raw:new Uint8Array(),setReject:reason=>refused.push(reason)});
  return {host,mail,env,edge,arrivals,kept,refused,inbox,message};
}

test('mail maintains random address rotation and sender + DMARC instruction boundary',async()=>{
  const s=setup();const request=new Request('https://host/address',{method:'POST',body:JSON.stringify({senders:['Person@Example.com']})});
  const first=await(await s.host.addressRequest(request,s.env,'account')).json();
  assert.match(first.address,/^[a-z0-9]{24}@/);
  await s.host.receiveMail(s.message(first.address),s.env,()=>s.inbox);
  assert.equal(s.arrivals[0].from_person,true);assert.ok(s.arrivals[0].text.startsWith('Exact  mail words'));
  assert.match(s.arrivals[0].files[0].id,/^1f:[a-f0-9]{64}$/);
  assert.equal(s.kept.length,1);
  s.mail.headers[0].value='dmarc=fail';
  await s.host.receiveMail(s.message(first.address),s.env,()=>s.inbox);
  assert.equal(s.arrivals[1].from_person,false);
  const rotated=await(await s.host.addressRequest(new Request('https://host/address',{method:'POST',body:'{"rotate":true}'}),s.env,'account')).json();
  assert.notEqual(rotated.address,first.address);
  await s.host.receiveMail(s.message(first.address),s.env,()=>assert.fail('retired address must not reach an account'));
  assert.deepEqual(s.refused,['No such address.']);
});

test('store outage keeps complete attachment at edge; permanent refusal names recoverable files',async()=>{
  const s=setup();const {address}=await(await s.host.addressRequest(new Request('https://host/address'),s.env,'account')).json();
  s.inbox.preflight=async()=>new Response('busy',{status:503});
  await s.host.receiveMail(s.message(address),s.env,()=>s.inbox);
  assert.equal(s.kept.length,0);assert.equal(s.arrivals.length,0);assert.equal(s.edge[0][2].files[0].base64,'BwgJ');assert.equal(s.refused.length,0);
  s.inbox.preflight=async()=>new Response('{}');s.inbox.fetch=async()=>Response.json({error:'Refused for good'},{status:403});
  await s.host.receiveMail(s.message(address),s.env,()=>s.inbox);
  assert.equal(s.kept.length,1);assert.match(s.refused[0],/attachments remain.*memo.wav/);
});

test('unsigned carrier authority is never synthesized from an ordinary records door',()=>{
  assert.throws(()=>createOwnInbound({}),error=>error.code==='inbound_service_owner_unavailable');
  assert.throws(()=>createInboundMail({}),error=>error.code==='inbound_mail_host_unavailable');
});

test('own-inbound mints exact inbound scope and maps pending import to retryable response',async()=>{
  let minted,captured;
  const {ownInbound}=createOwnInbound({PERSON_APP:'person',refusalStatus:()=>null,addressId:(_env,owner)=>'account:'+owner.key,mintServiceActor:async(_env,input)=>{minted=input;return {claims:{proof:'test-only'}};},nativeOwnConsumerContext:input=>input,callOwnResourceConsumer:async(path,input,method,context)=>{captured={path,input,method,context};return {taken:true};}});
  const owner=ownInbound({},'one');const response=await owner.preflight();assert.equal(response.status,200);
  assert.deepEqual(minted,{origin:'inbound-mail',account:'account:one',scope:{kind:'inbound',id:'account:one'}});
  assert.equal(captured.path,'/inbound');assert.equal(captured.context.claims.proof,'test-only');assert.deepEqual(captured.input,{preflight:true});
  const unavailable=createOwnInbound({PERSON_APP:'person',refusalStatus:()=>null,addressId:()=> 'account:one',mintServiceActor:async()=>{throw Object.assign(new Error('pending'),{code:'account_import_pending'});},nativeOwnConsumerContext:()=>{},callOwnResourceConsumer:()=>{}}).ownInbound({},'one');
  assert.equal((await unavailable.preflight()).status,503);
});
