// Route exact-label workspace reads through the selected native resource.
// The caller supplies a consumer already bound to the original principal.
export function nativeWorkspaceRecordReader({consumer,resource,localRead}){
 if(typeof consumer?.selectResource!=='function'||typeof consumer?.execute!=='function'||typeof localRead!=='function')
  throw new TypeError('A native workspace reader needs the addressed consumer and local owner.');
 return async selection=>{
  const operation='workspace:read',input={selection},requestKey=`workspace-read:${crypto.randomUUID()}`;
  const target=await consumer.selectResource({operation,input,request_key:requestKey});
  if(target!==resource)return consumer.execute(target,operation,input,requestKey);
  return localRead(input,requestKey);
 };
}

// An account's workspace records through its own routes (`own`, its consumer answering fetch(Request) as the account
// routes do): one record read by its label, and a write that names the identity it read, refused rather than kept as
// a second version when the record changed since (conflict_policy retry).
export function ownWorkspaceRecords(own){
 if(typeof own?.fetch!=='function')throw new TypeError('An account\'s own workspace records need its own routes.');
 const answer=async(response,what)=>{const body=await response.json().catch(()=>null);if(!response.ok)throw Object.assign(new Error(body?.error??`${what} could not be read.`),{status:response.status});return body;};
 return {
  workspaceRecord:async label=>(await answer(await own.fetch(new Request(`https://person/records?label=${encodeURIComponent(label)}`)),'The record'))?.records?.[label]??null,
  putWorkspaceRecords:async writes=>answer(await own.fetch(new Request('https://person/records',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({writes,conflict_policy:'retry'})})),'The record write'),
 };
}
