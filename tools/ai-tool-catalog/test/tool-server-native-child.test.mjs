import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { runNativeToolServerLifecycle } from '../do-work/tool-server-native-child.mjs';
const SERVER='https://remote.example/mcp';
const RETURN='http://127.0.0.1:47123/tool-servers/signed-in';
const NOW=Date.parse('2026-11-08T12:00:00Z');
async function fixture({exchangeGate,exchangeUnknown=false}={}) {
  const kinds=['tool-server-added','tool-server','tool-server-client','tool-server-pending','tool-server-claim','tool-server-callback','tool-server-attempt'];
  const door=await startFakeDoor({rights:kinds.map(kind=>({kind,operations:['records:read','records:write']}))});
  const calls=[];let state,stamp=NOW,operation='add',serial=7,signed=false,exchanges=0;
  let originalKey='original-native-setup';
  const actions={records:openRecordsDoor({descriptor:door.descriptor}),get requestKey(){return originalKey;},
    async call(method,input,key){
      calls.push({method,input:structuredClone(input),key});
      if(method==='context')return {server:SERVER,return_to:RETURN,client_name:'Synthetic native host',state,started_at:new Date(stamp).toISOString()};
      if(method==='scope.current'||method==='public.admit')return {};
      if(method==='sources.read')return {sources:[],kinds:{}};
      if(method==='public.request') {
        const path=new URL(input.url).pathname;let body;
        if(path.includes('oauth-protected-resource'))body={resource:SERVER,authorization_servers:['https://issuer.example']};
        else if(path.includes('oauth-authorization-server'))body={issuer:'https://issuer.example',authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',registration_endpoint:'https://issuer.example/register',code_challenge_methods_supported:['S256']};
        else if(path==='/register')body={client_id:'synthetic-client'};
        else throw new Error('unexpected-native-public-request');
        return {status:200,headers:{'content-type':'application/json'},text:JSON.stringify(body)};
      }
      if(method==='verifier.create')return {challenge:'A'.repeat(43)};
      if(method==='verifier.remove')return {};
      if(method==='callback.bind') {state=input.state;return {request_key:originalKey,scope_identity:'a'.repeat(64),owner_identity:'b'.repeat(64)};}
      if(method==='callback.admit') {
        if(input.callback_intake!=='opaque-synthetic-callback'||input.state!==state)throw new Error('native_callback_binding_refused');
        return {request_key:input.callback.request_key,scope_identity:input.callback.scope_identity,owner_identity:input.callback.owner_identity};
      }
      if(method==='exchange.keep') {
        exchanges++;
        assert.ok(!('code' in input));assert.ok(input.claim);assert.equal(input.claim.pending.server,SERVER);
        if(exchangeGate)await exchangeGate;
        if(exchangeUnknown)return {status:'unknown',request_key:input.claim.request_key};
        signed=true;return {kept:true,expires_at:new Date(NOW+3600000).toISOString(),signed_in_at:new Date(NOW+1000).toISOString()};
      }
      if(method==='exchange.recover')return null;
      if(method==='source.list') {
        return signed?{entries:[{name:'echo'}]}:{needs_sign_in:true};
      }
      if(method==='source.post') {
        if(!signed)return {status:401,headers:{},text:''};
        const message=JSON.parse(input.request.body);
        return {status:message.id===undefined?202:200,headers:{},text:message.id===undefined?'':JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[{name:'echo'}]}})};
      }
      throw new Error(`unexpected synthetic method ${method}`);
    }};
  return {door,calls,exchanges:()=>exchanges,run:(op,input)=>{operation=op;return runNativeToolServerLifecycle(op,input,{actions,now:()=>stamp,random:bytes=>{bytes.fill(serial);return bytes;}});},
    nextAttempt:()=>{stamp+=1000;originalKey='later-native-setup';serial++;},state:()=>state,close:()=>door.close()};
}

test('the child adapter uses existing records CAS and keeps raw callback values native',async()=>{
  const made=await fixture();try {
    await assert.rejects(made.run('add',{server:SERVER,key:'forbidden-raw-key'}),/tool_server_native_input_refused/);
    assert.equal(made.calls.length,0);
    const offered=await made.run('add',{server:SERVER});const state=new URL(offered.open).searchParams.get('state');
    const result=await made.run('finish',{state,callback_intake:'opaque-synthetic-callback'});
    assert.equal(result.state,'ready');assert.equal(made.exchanges(),1);
    const claim=made.door.kept.get(`tool-server-claim:${state}`).value;
    assert.equal(claim.request_key,'original-native-setup');assert.equal(claim.pending.server,SERVER);
    assert.ok(!made.door.kept.has(`tool-server-pending:${state}`));
    assert.ok(!made.door.kept.has(`tool-server-callback:${state}`));
    assert.ok(!JSON.stringify([...made.door.kept]).includes('opaque-synthetic-callback'));
    assert.ok(made.door.calls.some(call=>call.operation==='records:write'||call.method==='records:write'));
  } finally {await made.close();}
});
test('consumed original claim with no exchange receipt is unknown under its original key',async()=>{
  const made=await fixture({exchangeUnknown:true});try {
    const state=new URL((await made.run('add',{server:SERVER})).open).searchParams.get('state');
    await assert.rejects(made.run('finish',{state,callback_intake:'opaque-synthetic-callback'}),error=>error.outcome==='unknown'&&error.request_key==='original-native-setup');
    await assert.rejects(made.run('finish',{state}),error=>error.outcome==='unknown'&&error.request_key==='original-native-setup');
    assert.equal(made.exchanges(),1);
  } finally {await made.close();}
});
test('a newer attempt prevents an older first callback from publishing after a delayed exchange',async()=>{
  let release;const gate=new Promise(done=>{release=done;});
  const made=await fixture({exchangeGate:gate});try {
    const oldState=new URL((await made.run('add',{server:SERVER})).open).searchParams.get('state');
    const finishing=made.run('finish',{state:oldState,callback_intake:'opaque-synthetic-callback'});
    while(made.exchanges()===0)await new Promise(done=>setTimeout(done,1));
    made.nextAttempt();const newer=await made.run('add',{server:SERVER});const newState=new URL(newer.open).searchParams.get('state');
    assert.notEqual(newState,oldState);release();
    await assert.rejects(finishing,/tool_server_authorization_replaced/);
    assert.ok(!made.door.kept.has(`tool-server:${SERVER}`));
    assert.equal(made.door.kept.get(`tool-server-attempt:${SERVER}`).value.state,newState);
  } finally {release();await made.close();}
});
