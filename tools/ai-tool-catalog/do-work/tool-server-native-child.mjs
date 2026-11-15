// Executable product adapter on the existing private child capability door.
// Records remain ordinary records RPC, including the atomic pending/claim CAS.
// Protected calls carry only public metadata and opaque native intake handles.
import { openProtectedActions } from '../../records-door/read-data/records-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from '../read-data/tool-server-lifecycle.json' with { type: 'json' };
import { toolServerLifecycle } from './tool-server-lifecycle.mjs';
import { ToolServerNeedsSignIn } from './talk-to-a-tool-server.mjs';
import { rowSourceOf } from './source-template.mjs';

const failure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value)));
const families = ['added','sign_in','client','pending','claim','callback','attempt'];
const fact = (family,id) => `${data[`${family}_fact_prefix`]}${id}`;
function kind(id) {
  const family = families.find(family => id.startsWith(data[`${family}_fact_prefix`]));
  if (!family) throw failure('tool_server_fact_refused');
  return data[`${family}_fact_prefix`].slice(0,-1);
}
const expected = held => held ? typeof held.identity === 'string' ? {type:held.type,identity:held.identity} : {type:held.type,value:held.value} : null;

export async function runNativeToolServerLifecycle(operation, input, { actions = openProtectedActions(), now = () => Date.now(), random } = {}) {
  if (!['add','start','finish'].includes(operation) || !object(input) || ['key','code','access_token','refresh_token','code_verifier'].some(key=>Object.hasOwn(input,key))) throw failure('tool_server_native_input_refused');
  const native = (method,value) => actions.call(data.native_methods[method],value,hash([actions.requestKey,method,value]));
  const context = await native('context',{});
  if (!object(context) || typeof context.server !== 'string' || typeof context.return_to !== 'string' || typeof context.client_name !== 'string'
    || operation !== 'finish' && input.server !== context.server || operation === 'finish' && input.state !== context.state) throw failure('tool_server_native_context_refused');
  if(operation==='finish' && context.callback_intake)input={...input,callback_intake:context.callback_intake};
  const records=actions.records;
  const read = id => records.readRecord(kind(id),id);
  const attemptId=fact('attempt',context.server);
  const latest = async state => {
    const held=await read(attemptId);
    if(!held || held.value.state!==state)throw failure('tool_server_authorization_replaced');
    return {id:attemptId,type:kind(attemptId),value:held.value,expected:expected(held)};
  };
  const write = async (id,value) => {
    const held=await read(id);
    if (held && JSON.stringify(held.value) === JSON.stringify(value) || !held && value === null) return;
    const changes=[{id,type:kind(id),value,expected:expected(held)}];
    if(id.startsWith(data.sign_in_fact_prefix))changes.push(await latest(value.authorization_state));
    await records.write(changes,{key:hash([actions.requestKey,'facts',changes])});
  };
  if(operation!=='finish') {
    if(typeof context.started_at!=='string'||!Number.isFinite(Date.parse(context.started_at)))throw failure('tool_server_native_context_refused');
    const held=await read(attemptId);
    if(held?.value.request_key!==actions.requestKey) {
      if(held && Date.parse(held.value.started_at)>Date.parse(context.started_at))throw failure('tool_server_authorization_replaced');
      await write(attemptId,{request_key:actions.requestKey,started_at:context.started_at,state:null});
    }
  }
  const facts={
    read:async id=>(await read(id))?.value??null,
    write,
    async consumePending(id,callback) {
      const held=await read(id);if(!held)return null;
      const routing=await read(fact('callback',callback.state));
      const attempt=await latest(callback.state);
      const admitted=await native('admit_callback',{...callback,pending_identity:held.identity??null,callback:routing?.value??null,attempt});
      if(!object(admitted)||typeof admitted.request_key!=='string'||!admitted.request_key||!/^[a-f0-9]{64}$/.test(admitted.scope_identity)||!/^[a-f0-9]{64}$/.test(admitted.owner_identity)) throw failure('tool_server_callback_binding_refused');
      const claimId=fact('claim',callback.state);
      const changes=[{id,type:kind(id),value:null,expected:expected(held)},
        {id:claimId,type:kind(claimId),value:{state:callback.state,pending:held.value,...admitted},expected:null},attempt];
      if(routing)changes.push({id:fact('callback',callback.state),type:kind(fact('callback',callback.state)),value:null,expected:expected(routing)});
      // One original writer transaction consumes the exact pending/root and
      // retains its public recovery claim. No code or verifier is in this body.
      await records.write(changes,{key:hash([admitted.request_key,'consume',callback.state])});
      return held.value;
    },
  };
  const vault=Object.fromEntries(['acceptKeyIntake','rollbackKey','createVerifier','removeVerifier','exchangeAndKeep'].map(method=>[method,async value=>{
    if(method==='exchangeAndKeep') {
      await latest(value.state);
      const claim=(await read(fact('claim',value.state)))?.value;
      const answer=await native(method,{...value,claim});
      if(answer?.status==='unknown'||answer?.status==='refused')throw Object.assign(failure(answer.status==='unknown'?'tool_server_exchange_unknown':'tool_server_exchange_refused'),{...(answer.status==='unknown'?{outcome:'unknown'}:{}),request_key:answer.request_key});
      return answer;
    }
    return native(method,value);
  }]));
  const callbacks={
    async remember({state,pending,expires_at}) {
      const attempt=await read(attemptId);
      if(attempt?.value.request_key!==actions.requestKey)throw failure('tool_server_authorization_replaced');
      const scope=await native('bind_state',{state,pending,expires_at,attempt_identity:attempt.identity??null});
      const callbackId=fact('callback',state);
      const changes=[{id:callbackId,type:kind(callbackId),value:{state,server:context.server,expires_at,...scope},expected:null},
        {id:attemptId,type:kind(attemptId),value:{...attempt.value,state},expected:expected(attempt)}];
      await records.write(changes,{key:hash([actions.requestKey,'bind-state',state])});
    },
    forget:state=>write(fact('callback',state),null),
    async recover(state) {
      const claim=(await read(fact('claim',state)))?.value;
      if(!claim)return null;
      await latest(state);
      return await native('recover',{state,claim})??{status:'unknown',request_key:claim.request_key};
    },
  };
  const request=async (url,init={})=>{
    const answer=await native('public_request',{url,method:init.method??'GET',headers:init.headers??{},...(init.body===undefined?{}:{body:init.body})});
    return new Response(answer.text,{status:answer.status,headers:answer.headers});
  };
  const lifecycle=toolServerLifecycle({facts,vault,callbacks,request,now,...(random?{random}:{}),
    returnTo:context.return_to,clientName:context.client_name,
    rowSources:async()=>{
      const snapshot=await native('sources',{});
      if(!object(snapshot)||!Array.isArray(snapshot.sources)||!object(snapshot.kinds))throw failure('tool_server_source_definitions_refused');
      return snapshot.sources.map(source=>source.kind==='tool-row-source'?source:rowSourceOf(source,snapshot.kinds));
    },admitAddress:url=>native('admit_address',{url}),assertCurrent:()=>native('current',{}),
    postFor:()=>null,
    listFor:async source=>{const answer=await native('source_list',{source});if(answer?.needs_sign_in)throw new ToolServerNeedsSignIn(source.list.mcp.url,answer.challenge??'');if(!Array.isArray(answer?.entries))throw failure('tool_server_source_list_refused');return answer.entries;},
  });
  if(operation==='start')return lifecycle.start(input.server,input.challenge??{});
  return lifecycle[operation](operation==='finish'?{state:input.state,...(input.callback_intake?{callback_intake:input.callback_intake}:{}),...(input.error?{error:input.error}:{})}:input);
}

export const addToolServerFromNativeTask = input => runNativeToolServerLifecycle(input?.state?'finish':'add',input);
export const finishToolServerFromNativeTask = input => runNativeToolServerLifecycle('finish',input);
