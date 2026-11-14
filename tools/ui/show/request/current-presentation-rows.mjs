// A mounted presentation keeps its selected document for immediate local
// feedback. Refresh is demand from mounting, focus, visibility or the host's
// existing content-change signal. No event waits for a network read or is replayed.
export function currentPresentationRows({rows,source,subscribe,onRows=()=>{},failed=()=>{},clearBeforeRefresh=false,page=globalThis.window,document=globalThis.document}){
 let selected=rows,stopped=false,generation=0;
 const invalidate=()=>{if(stopped)return;generation++;selected=null;onRows(null);};
 const refresh=async()=>{
  if(!source||stopped)return;
  if(clearBeforeRefresh)invalidate();
  const mine=++generation;
  try{const next=await source();if(stopped||mine!==generation)return;selected=next;onRows(next);}
  catch(error){if(stopped||mine!==generation)return;selected=null;onRows(null);failed(error);}
 };
 const shown=()=>{if(document?.visibilityState==='visible')void refresh();};
 // Keep the existing single callback subscription contract: some hosts use
 // their second argument for read filters. Account adapters may invalidate
 // synchronously through the callback's method before starting a refresh.
 refresh.invalidate=invalidate;
 page?.addEventListener('focus',refresh);document?.addEventListener('visibilitychange',shown);
 const stopChanges=source&&subscribe?subscribe(refresh):()=>{};
 if(source)void refresh();
 return {read:()=>selected,refresh,invalidate,stop(){stopped=true;generation++;stopChanges?.();page?.removeEventListener('focus',refresh);document?.removeEventListener('visibilitychange',shown);}};
}
