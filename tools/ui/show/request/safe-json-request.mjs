function messageFor(response,text,fallback){
  if(response.status===404)return 'This action is not available yet. Reload the app and try again.';
  if(response.status===413)return 'That selection is too large. Choose fewer items and try again.';
  if(response.status===429)return 'The app is busy. Wait a moment and try again.';
  if(response.status>=500)return 'That action did not finish. Try again.';
  const plain=String(text||'').trim();
  return plain&&plain.length<=240&&!/<[a-z][\s\S]*>/i.test(plain)?plain:fallback;
}

export async function readJsonResponse(response,{fallback='Could not complete this action.'}={}){
  let text='',value=null;
  if(typeof response.text==='function'){
    text=await response.text();
    if(text.trim())try{value=JSON.parse(text);}catch{}
  }else if(typeof response.json==='function'){
    try{value=await response.json();text=value?.error||'';}catch{}
  }
  if(!response.ok||value?.error)throw new Error(value?.error||messageFor(response,text,fallback));
  if(value===null)throw new Error('The answer could not be read. Try again.');
  return value;
}

export const SLOW_REQUEST_MESSAGE='This is taking too long to answer. Try again.';

// timeoutMs bounds the whole exchange, headers and body, so a caller showing a
// loading state always reaches content or a clear failure it can offer to
// retry. A server that stops answering otherwise leaves the request pending
// forever. The caller's own signal still cancels it early.
export async function requestJson(url,{body,signal,method,headers,fallback,timeoutMs}={}){
  const hasBody=body!==undefined;
  const deadline=timeoutMs>0?AbortSignal.timeout(timeoutMs):null;
  const combined=deadline?(signal?AbortSignal.any([signal,deadline]):deadline):signal;
  try{
    const response=await fetch(url,{...(hasBody?{method:method||'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:method||headers?{method,headers}:{}),signal:combined});
    return await readJsonResponse(response,{fallback});
  }catch(error){
    if(deadline?.aborted&&!signal?.aborted)throw new Error(SLOW_REQUEST_MESSAGE);
    throw error;
  }
}
