// Presentation DATA may name an existing readonly fact. It cannot grant a new
// request route, method, credential destination or execution capability.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const present=value=>object(value)&&Object.keys(value).length>0;
const factReads=Object.freeze({'ai-connection':'/work/api/ai-connection'});
const unavailable=()=>Object.assign(new Error('The tour fact is not currently available.'),{code:'tour_fact_unavailable'});
const button=value=>{
 if(!object(value)||typeof value.role!=='string'||typeof value.label!=='string'||!value.label.trim())throw new TypeError('A tour button needs its role and label.');
 if(value.perform!==undefined&&(!object(value.perform)||typeof value.perform.target!=='string'||typeof value.perform.operation!=='string'||value.perform.params!==undefined&&!object(value.perform.params)))throw new TypeError('A tour button needs a declared owner action.');
};
export function checkedTourWordContent(value){
 if(!object(value))throw new TypeError('Tour words must be a document.');
 const rows={readbacks:{}};
 if(value.end_label!==undefined){if(typeof value.end_label!=='string'||!value.end_label.trim())throw new TypeError('The end-tour label must be text.');rows.end_label=value.end_label;}
 if(present(value.closing_step)){
  const step=value.closing_step;
  if(typeof step.id!=='string'||!step.id||!object(step.content)||typeof step.content.content_kind!=='string'||!object(step.content.payload))throw new TypeError('The closing tour step needs its id and content.');
  if(step.nav!==undefined){if(!object(step.nav)||!Array.isArray(step.nav.buttons))throw new TypeError('Tour navigation needs buttons.');for(const row of step.nav.buttons)button(row);}
  rows.closing_step=step;
 }else if(value.closing_step!==undefined&&!object(value.closing_step))throw new TypeError('The closing tour step must be a document.');
 if(present(value.more_waiting)){button(value.more_waiting);rows.more_waiting=value.more_waiting;}
 else if(value.more_waiting!==undefined&&!object(value.more_waiting))throw new TypeError('The waiting-tour button must be a document.');
 if(value.readbacks!==undefined){
  if(!object(value.readbacks))throw new TypeError('Tour readbacks must be named readonly facts.');
  for(const [ref,row]of Object.entries(value.readbacks)){
   if(!Object.hasOwn(factReads,ref)||!object(row)||Object.keys(row).some(key=>key!=='url')||row.url!==factReads[ref])throw new TypeError('A tour readback must name its admitted readonly fact route.');
   rows.readbacks[ref]={url:row.url};
  }
 }
 return rows;
}
/** The admitted address of one readonly fact, by its ref alone: a fact never waits on the tour's words to be read. */
export function tourFactAddress(ref){
 if(!Object.hasOwn(factReads,ref))throw unavailable();
 return factReads[ref];
}
export function tourFactRoute(rows,ref){
 const route=rows?.readbacks?.[ref]?.url;
 if(!Object.hasOwn(factReads,ref)||route!==factReads[ref])throw unavailable();
 return route;
}
/** A bridge is tied to one selected document. Its owner fences generation and
 * session after awaits; missing refs explicitly clear an earlier true fact. */
export function tourFactBridge(rows,{read,current=()=>{}}){
 const selected=checkedTourWordContent(rows);
 return async refs=>{
  if(!Array.isArray(refs)||refs.length>16||refs.some(ref=>typeof ref!=='string'))throw new TypeError('Read bounded opaque tour facts.');
  await current();
  const entries=await Promise.all([...new Set(refs)].map(async ref=>{
   if(!Object.hasOwn(selected.readbacks,ref))return [ref,null];
   const answer=await read(tourFactRoute(selected,ref));await current();return [ref,answer];
  }));
  await current();return Object.fromEntries(entries);
 };
}
