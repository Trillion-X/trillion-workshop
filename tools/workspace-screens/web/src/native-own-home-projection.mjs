// One canonical reduction for browser and MCP consumers of bounded Home pages.
import {whatHelpedOf} from './check-uses.mjs';
const unique=(pages,field,key)=>{
 const byId=new Map();for(const page of pages)for(const row of page[field]??[]){const id=row[key];if(typeof id!=='string')throw new Error(`The Home ${field} page lacks its identity.`);const prior=byId.get(id);if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw new Error('Home changed during its collection read.');byId.set(id,row);}return [...byId.values()];
};
const newest=(rows,time,key,ascendingTie=false)=>rows.sort((a,b)=>String(b[time]??'').localeCompare(String(a[time]??''))||(ascendingTie?String(a[key]).localeCompare(String(b[key])):String(b[key]).localeCompare(String(a[key]))));
export function mergeNativeHomePages(pages){
 const last=pages.at(-1);if(!last)throw new Error('Home has no current page.');if(last.free)return last;
 const {helped_items:discardItems,agent_work:discardAgents,helped_check_text:discardChecks,...metadata}=last;
 const pursuits=unique(pages,'pursuits','id').sort((a,b)=>String(a.id).localeCompare(String(b.id))),current=new Set(pursuits.map(row=>row.id)),children=new Map(pursuits.map(row=>[row.id,[]]));
 const tree=pursuits.map(row=>({...row,parents:[...new Set(row.parents??[])].filter(id=>current.has(id)&&id!==row.id)}));
 for(const row of tree)for(const parent of row.parents)children.get(parent).push(row.id);
 const complete=!last.next;
 const coverage=pages.map(page=>page.collection_coverage).filter(Boolean),snapshot=coverage.filter(row=>!row.initial_projection_pending).map(row=>row.snapshot_revision).filter(value=>value!==undefined);
 if(new Set(snapshot).size>1)throw new Error('Home pages belong to different published snapshots.');
 return {...metadata,summaries:newest(unique(pages,'summaries','case_id'),'created_at','case_id').slice(0,100),
  pursuits:tree.map(row=>({...row,children:children.get(row.id)})),plans:newest(unique(pages,'plans','id'),'updated_at','id',true).slice(0,100),
  helped:complete?whatHelpedOf(unique(pages,'helped_items','id'),{checkText:last.helped_check_text??{},agentWork:unique(pages,'agent_work','id')}):null,
  pursuits_words:tree.length||(metadata.space_pursuits??[]).length?null:metadata.pursuits_words,
  next:last.next??null,collection_coverage:{...last.collection_coverage,complete:false,published_snapshot_complete:complete,current_membership_complete:false,projection_consistency:'asynchronous',ordering_scope:'published_reference_snapshot',values_scope:'current_resource_values',scope:'published_installed_resource_references',statistics_scope:'currently_hydrated_published_source_pages',source_pages:pages.length,source_projection_pending:coverage.some(row=>row.source_projection_pending===true),projection_stale:coverage.some(row=>row.projection_stale===true)}};
}
