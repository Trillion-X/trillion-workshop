const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const stats=values=>{
  if(!values.length)return {available:false,samples:0,total_ms:null,min_ms:null,max_ms:null,mean_ms:null};
  const total=values.reduce((sum,value)=>sum+value,0);
  return {available:true,samples:values.length,total_ms:total,min_ms:values.reduce((min,value)=>Math.min(min,value),Infinity),max_ms:values.reduce((max,value)=>Math.max(max,value),-Infinity),mean_ms:total/values.length};
};

/** Pure read of actual persisted draft state-transition events. No filesystem
 * checks or historical times inferred from created_at/updated_at. parentId
 * scopes records; now is optional and used only for explicit open intervals.
 */
export function summarizeDraftOperations(records,{parentId,now}={}){
  if(!Array.isArray(records))throw new TypeError('Provide saved draft records.');
  const nowMs=now===undefined?null:timestamp(now);if(now!==undefined&&nowMs===null)throw new TypeError('Provide an ISO observation time.');
  const selected=records.filter(record=>record&&(parentId===undefined||record.parent_id===parentId));
  const seen=new Set(),byState=Object.create(null),byDisposition=Object.create(null),eventCounts=Object.create(null),durations=Object.create(null),queuedToComplete=[],completeToDisposition=[],perDraft=[];
  const coverage={records:selected.length,records_with_events:0,records_without_events:0,records_with_invalid_history:0,records_without_identity:0,duplicate_records:0,closed_state_intervals:0,open_intervals:0};
  for(const record of selected){
    if(typeof record.id!=='string'||!record.id){coverage.records_without_identity++;continue;}
    if(seen.has(record.id)){coverage.duplicate_records++;continue;}seen.add(record.id);
    const state=typeof record.state==='string'&&record.state?record.state:'unknown';byState[state]=(byState[state]||0)+1;
    const disposition=typeof record.disposition==='string'&&record.disposition?record.disposition:'unreviewed';byDisposition[disposition]=(byDisposition[disposition]||0)+1;
    const result={id:record.id,parent_id:record.parent_id,state,history_available:false,closed_intervals:[],open_interval:null,queued_to_first_complete_ms:null,first_complete_to_first_disposition_ms:null};perDraft.push(result);
    if(!Array.isArray(record.events)||!record.events.length){coverage.records_without_events++;continue;}
    coverage.records_with_events++;
    // Invalid or out-of-order history makes its durations unavailable. Sorting
    // or dropping the bad event would manufacture a plausible timeline.
    let previous=-Infinity;
    const invalid=record.events.some(event=>{const at=timestamp(event?.at);if(at===null||at<previous)return true;previous=at;return typeof event.state!=='string'&&!Object.hasOwn(event,'disposition');});
    if(invalid){coverage.records_with_invalid_history++;result.history_error='Invalid or out-of-order event timestamps';continue;}
    result.history_available=true;
    const states=[];
    for(const event of record.events){
      if(typeof event.state!=='string'||!event.state||states.at(-1)?.state===event.state)continue;
      const value={state:event.state,at:event.at,ms:timestamp(event.at)};states.push(value);eventCounts[event.state]=(eventCounts[event.state]||0)+1;
    }
    for(let i=0;i<states.length-1;i++){
      const from=states[i],to=states[i+1],interval={state:from.state,started_at:from.at,ended_at:to.at,duration_ms:to.ms-from.ms};
      result.closed_intervals.push(interval);(durations[from.state]??=[]).push(interval.duration_ms);coverage.closed_state_intervals++;
    }
    const firstComplete=states.find(event=>event.state==='complete'),firstQueued=states.find(event=>event.state==='queued');
    if(firstComplete&&firstQueued&&firstComplete.ms>=firstQueued.ms){result.queued_to_first_complete_ms=firstComplete.ms-firstQueued.ms;queuedToComplete.push(result.queued_to_first_complete_ms);}
    const firstDisposition=firstComplete&&record.events.find(event=>typeof event.disposition==='string'&&event.disposition&&timestamp(event.at)>=firstComplete.ms);
    if(firstDisposition){result.first_complete_to_first_disposition_ms=timestamp(firstDisposition.at)-firstComplete.ms;completeToDisposition.push(result.first_complete_to_first_disposition_ms);}
    const last=states.at(-1);
    if(nowMs!==null&&last&&['queued','planning','rendering','cancelling'].includes(last.state)&&last.state===state&&nowMs>=last.ms){result.open_interval={state:last.state,started_at:last.at,observed_at:now,elapsed_ms:nowMs-last.ms};coverage.open_intervals++;}
  }
  return {record_count:seen.size,by_state:{...byState},by_disposition:{...byDisposition},state_event_counts:{...eventCounts},coverage,timings:{closed_states:Object.fromEntries(Object.entries(durations).map(([state,values])=>[state,stats(values)])),queued_to_first_complete:stats(queuedToComplete),first_complete_to_first_disposition:stats(completeToDisposition)},drafts:perDraft,unavailable:[
    {metric:'import_to_evidence_and_organization',reason:'Draft records do not contain verified import, evidence-ready and organization timestamps.'},
    {metric:'render_resource_use_and_waste',reason:'State durations do not measure CPU, memory, bytes, energy or whether discarded rendering was avoidable.'},
    {metric:'correction_effort_and_learning_improvement',reason:'Disposition events do not measure editing effort, repeated mistakes or later output quality.'},
    {metric:'editor_import_and_publication',reason:'A completed draft or review disposition does not prove editor import or publication.'}
  ]};
}
