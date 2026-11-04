// Stateless affinity checks for the installed published-item physical supply.
// The native gate, original command journal and meter remain the authorities;
// neither a supplied binding name nor a serialized physical id selects a host.
import {canonical} from '../../shared-code/src/typed-operation-contract.mjs';

const shelves=new Set(['public-app','configuration','look','content']);
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const fail=message=>Object.assign(new Error(message),{status:403,code:'published-placement-refused'});
const same=(left,right)=>canonical(left)===canonical(right);

export function publishedResourceIdentity(resource){
 let identity;
 try{identity=typeof resource==='string'&&resource.startsWith('publication:')?JSON.parse(resource.slice('publication:'.length)):null;}catch{}
 if(!Array.isArray(identity)||identity.length!==2||!shelves.has(identity[0])||typeof identity[1]!=='string'||!identity[1]||identity[1].length>1000
  ||resource!==`publication:${JSON.stringify(identity)}`)throw fail('An exact installed published-item resource is required.');
 return {shelf:identity[0],id:identity[1]};
}

export function assertPublishedCommitment(address,{owner=address?.owner,resource=address?.resource,target=null}={}){
 publishedResourceIdentity(resource);
 if(!record(address)||!text(owner)||address.supply!=='published-item'||address.owner!==owner||address.resource!==resource
  ||address.address!==resource||address.binding!=='POOL'||address.generation!==1)throw fail('The original published-item commitment names another owner or incarnation.');
 if(address.lifecycle!==undefined||address.operation!==undefined){
  const lifecycle=address.lifecycle,authority=lifecycle?.account_erasure;
  if(!['publication:erase','publication:retire-erasure'].includes(address.operation)||lifecycle?.kind!=='account-erasure'
   ||!record(authority)||authority.owner!==owner||!text(authority.policy_update)||lifecycle.erasure_relay!==authority.relay)
   throw fail('The published-item deletion commitment names another original account authority.');
 }
 if(target!==null&&(!record(target)||target.owner!==owner||target.resource!==resource||!record(target.commitment)||!same(target.commitment,address)))
  throw fail('The published-item reconciliation target differs from its original signed commitment.');
 return address;
}

const physical=(env,resource)=>{
 const binding=env?.POOL;
 if(typeof binding?.idFromName!=='function'||typeof binding.get!=='function')throw fail('The installed published-item physical supply is unavailable.');
 const id=binding.idFromName(resource);
 if(!id||typeof id.toString!=='function'||!text(id.toString()))throw fail('The published-item physical identity is unavailable.');
 return {binding,id};
};

// Gate targets retain the exact signed commitment. Recover that original item,
// never a caller-provided physical id or today's discovery projection.
export function resolvePublishedCommitment(env,address,target=null){
 assertPublishedCommitment(address,{target});
 const {binding,id}=physical(env,address.resource);
 return binding.get(id);
}

// resourceQuotaCredits retains {placement,owner,address,resource} in target_json;
// its command commitment is a separate request field, absent from that target.
export function resolvePublishedQuotaTarget(env,owner,target){
 if(!record(target)||!text(owner)||target.owner!==owner||target.address!==target.resource)
  throw fail('The publication quota allocation names another account or resource.');
 publishedResourceIdentity(target.resource);
 if(target.commitment!==undefined)assertPublishedCommitment(target.commitment,{owner,resource:target.resource});
 if(target.account_erasure!==undefined&&target.account_erasure?.owner!==owner)
  throw fail('The publication quota erasure allocation names another account.');
 const {binding,id}=physical(env,target.resource),placement=target.placement;
 if(!record(placement)||placement.binding!=='POOL'||typeof placement.id!=='string'||placement.id!==id.toString())
  throw fail('The publication quota allocation lost its exact original physical placement.');
 return binding.get(id);
}

// Current deletion authority must still be checked at its policy owner before
// and after the physical read. This comparison supplies only exact proof affinity.
export function assertPublishedErasureProof(owner,authority,proof){
 if(!text(owner)||!record(authority)||authority.owner!==owner||!text(authority.policy_update)
  ||!record(proof)||proof.found!==true||!record(proof.authority)||proof.authority.owner!==owner||!same(proof.authority,authority))
  throw fail('That copied publication result has no exact original account-erasure proof.');
 return proof;
}
