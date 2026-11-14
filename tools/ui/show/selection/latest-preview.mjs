// Coalesce edits while preserving one render at a time. Never paint an old result.
export function createLatestPreview({render,apply,onState,delay=300}){
 let latest=0,pending=null,running=false,timer,closed=false;
 async function drain(){
  if(closed||running||!pending)return;
  const work=pending;pending=null;running=true;onState('rendering');
  try{const result=await render(work.value);if(!closed&&work.version===latest){await apply(result);if(!closed&&work.version===latest)onState('ready');}}
  catch(error){if(!closed&&work.version===latest)onState('error',error);}
  finally{running=false;if(pending&&!closed)void drain();}
 }
 return {update(value){if(closed)return;pending={value,version:++latest};onState('pending');clearTimeout(timer);timer=setTimeout(drain,delay);},close(){closed=true;pending=null;clearTimeout(timer);}};
}
