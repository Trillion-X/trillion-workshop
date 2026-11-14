// Adjustment layers: a color change applied to an area of the frame between
// two times, optionally limited to a tracked object. A configuration of the
// shared timed layer editor.
import {mountTimedLayerEditor} from './timed-layer-editor.mjs';

const TONE=[['brightness','Brightness',0,2,.01,1],['contrast','Contrast',0,2,.01,1],['saturation','Saturation',0,2,.01,1],['exposure','Exposure',-2,2,.01,0],['temperature','Temperature',-1,1,.01,0],['hue','Hue',-180,180,1,0]];
const AREA=[['x','Area left',0,1,0],['y','Area top',0,1,0],['width','Area width',.01,1,1],['height','Area height',.01,1,1]];

export function mountAdjustmentEditor(host,{layers=[],duration,getTime,onChange,onSeek,onMask,onPreviewMask,timelineDriven=false}){
 return mountTimedLayerEditor(host,{layers,duration,getTime,onChange,onSeek,timelineDriven,label:'Adjustment layers',
  fields:row=>[
   {id:'name',label:'Name',wide:true},
   ...TONE.map(([id,label,min,max,step,defaultValue])=>({id,label,type:'range',min,max,step,defaultValue})),
   {id:'start',label:'Effect from',type:'number',min:0,max:duration,step:'any'},
   {id:'end',label:'Effect until',type:'number',min:0,max:duration,step:'any'},
   ...(row.mask_id?[]:AREA.map(([id,label,min,max,defaultValue])=>({id,label,type:'number',min,max,step:'any',defaultValue}))),
  ],
  precisionFields:['name','start','end',...AREA.map(([id])=>id)],
  actions:row=>[
   {id:'seek',label:'Go to layer'},
   ...(onMask?[{id:'mask',label:row.mask_id?'Reselect object':'Select object'}]:[]),
   ...(row.mask_id&&onPreviewMask?[{id:'show-mask',label:'Show or hide selected area'}]:[]),
   ...(row.mask_id?[{id:'clear-mask',label:'Remove object mask'}]:[]),
  ],
  onAction:(id,row,api)=>{const index=api.read().findIndex(candidate=>candidate.id===row.id);
   if(id==='mask')onMask(index,structuredClone(row));
   if(id==='show-mask')onPreviewMask(row.mask_id);
   if(id==='clear-mask'){const rows=api.read(),[removed]=rows.splice(index,1);delete removed.mask_id;queueMicrotask(()=>{api.remove(index);api.restore(index,removed);});}},
  makeRow:start=>({id:crypto.randomUUID(),name:'Adjustment',start,end:duration,brightness:1,contrast:1,saturation:1,exposure:0,temperature:0,hue:0,x:0,y:0,width:1,height:1}),
  validate:row=>{const bounded=TONE.every(([id,,min,max])=>Number.isFinite(row[id])&&row[id]>=min&&row[id]<=max);const area=row.mask_id||AREA.every(([id,,min,max])=>Number.isFinite(row[id])&&row[id]>=min&&row[id]<=max)&&row.x+row.width<=1.00001&&row.y+row.height<=1.00001;return bounded&&area&&row.start>=0&&row.end<=duration&&row.end>row.start;},
  addLabel:'Add adjustment layer',removeLabel:'Remove adjustment'});
}
