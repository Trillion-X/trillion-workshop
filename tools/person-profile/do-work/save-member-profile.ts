import {sendRequestToBitfieldTarget} from '@bitfield/runtime-kit';

export type MemberProfileFields={display_name:string;about:string;email?:string};
const storagePrefix='person-profile.member-profile.v1:';
const addressFor=(actorRef:string)=>`package::person-profile::member-profile::${encodeURIComponent(actorRef).replace(/%/g,'_')}`;

export function readCachedMemberProfile(actorRef:string):MemberProfileFields|null{
  try{
    const raw=globalThis.localStorage?.getItem(storagePrefix+actorRef);
    if(!raw)return null;
    const value=JSON.parse(raw);
    if(!value||typeof value!=='object')return null;
    return {display_name:typeof value.display_name==='string'?value.display_name:typeof value.displayName==='string'?value.displayName:'',about:typeof value.about==='string'?value.about:'',...(typeof value.email==='string'?{email:value.email}:{})};
  }catch{return null;}
}

async function readMemberProfileRecord(actorRef:string):Promise<Record<string,unknown>|null>{
  const reply=await sendRequestToBitfieldTarget({target:'engine.operation.label-addressed',payload:{operation_label:'engine.operation.read-current',address_label:addressFor(actorRef)}}) as {payload?:Uint8Array};
  if(!reply.payload)throw Error('Profile read was not confirmed.');
  const result=JSON.parse(new TextDecoder().decode(reply.payload));
  if(result.found===false)return null;
  const value=result.payload;
  if(result.found!==true||!value||value.kind!=='person-profile.member-profile/v1'||value.actor_ref!==actorRef)throw Error('Saved profile is unavailable.');
  return value;
}
export async function readMemberProfile(actorRef:string):Promise<MemberProfileFields|null>{
  const value=await readMemberProfileRecord(actorRef);
  if(!value)return null;
  return {display_name:typeof value.display_name==='string'?value.display_name:'',about:typeof value.about==='string'?value.about:'',...(typeof value.email==='string'?{email:value.email}:{})};
}

export async function saveMemberProfile(actorRef:string,fields:MemberProfileFields):Promise<void>{
  if(!actorRef||actorRef.length>200)throw Error('Profile identity is unavailable.');
  const prior=await readMemberProfileRecord(actorRef);
  const payload={...prior,kind:'person-profile.member-profile/v1',actor_ref:actorRef,updated_at:new Date().toISOString(),display_name:fields.display_name.trim(),about:fields.about.trim(),email:fields.email?.trim()||''};
  const reply=await sendRequestToBitfieldTarget({target:'engine.operation.label-addressed',payload:{operation_label:'engine.operation.write-batch',writes:[{address_label:addressFor(actorRef),path_labels:['person-profile','member-profile'],payload}]}}) as {payload?:Uint8Array};
  if(!reply.payload)throw Error('Profile save was not confirmed.');
  const result=JSON.parse(new TextDecoder().decode(reply.payload));
  const count=result.write_count??result.writeCount;
  if(count!==1)throw Error('Profile save was not confirmed.');
  const current=await readMemberProfile(actorRef);
  if(!current||current.display_name!==payload.display_name||current.about!==payload.about||(current.email||'')!==payload.email)throw Error('Profile save could not be verified.');
  try{globalThis.localStorage?.setItem(storagePrefix+actorRef,JSON.stringify(fields));}catch{}
}
