// A choice (such as a look) applied to a stretch of the video. Rows that were
// inserted together share one track. A configuration of the shared timed
// layer editor.
import {mountTimedLayerEditor} from './timed-layer-editor.mjs';

export function mountTimedChoiceEditor(host,{layers=[],choices=[],duration,getTime,onChange,onSeek,timelineDriven=false,addLabel='Add timed choice',emptyLabel='Choose an option',choiceLabel='Look'}={}){
 const available=new Set(choices.map(choice=>choice.id));
 const makeRow=(presetId,start,end,trackId)=>({id:crypto.randomUUID(),preset_id:presetId,track_id:trackId||'timed-choice-track-'+crypto.randomUUID(),start,end});
 const editor=mountTimedLayerEditor(host,{layers,duration,getTime,onChange,onSeek,timelineDriven,label:choiceLabel,
  fields:[
   {id:'preset_id',label:choiceLabel,options:choices.map(choice=>({value:choice.id,label:choice.name}))},
   {id:'start',label:choiceLabel+' from',type:'number',min:0,max:duration,step:'any'},
   {id:'end',label:choiceLabel+' until',type:'number',min:0,max:duration,step:'any'},
  ],
  precisionFields:['start','end'],
  actions:()=>[{id:'seek',label:'Go to '+choiceLabel.toLowerCase()}],
  makeRow:start=>choices[0]?makeRow(choices[0].id,start,Math.min(duration,Math.max(start+.1,start+5))):null,
  validate:row=>available.has(row.preset_id)&&Number.isFinite(row.start)&&Number.isFinite(row.end)&&row.start>=0&&row.end<=duration&&row.end>row.start,
  addLabel,emptyLabel,removeLabel:'Remove timed '+choiceLabel.toLowerCase()});
 return {...editor,insert(ids,start,end){if(!Array.isArray(ids)||!ids.length||ids.some(id=>!available.has(id)))throw Error('Choose a look that supports timeline timing.');const track='timed-choice-track-'+crypto.randomUUID();let index=-1;for(const id of ids)index=editor.append(makeRow(id,start,end,track));return index;}};
}
