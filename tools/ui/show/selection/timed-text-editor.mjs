// Timed text on a video: each row is words shown between two times at a
// position in the frame. A configuration of the shared timed layer editor.
import {mountTimedLayerEditor} from './timed-layer-editor.mjs';

export function mountTimedTextEditor(host,{layers=[],duration,getTime,onChange,onEdit,onSeek,timelineDriven=false}){
 const editor=mountTimedLayerEditor(host,{layers,duration,getTime,onChange,onEdit,onSeek,timelineDriven,label:'Text',
  fields:()=>[
   {id:'text',label:'Text',multiline:true,rows:3,wide:true},
   {id:'start',label:'Show from',type:'number',min:0,max:duration,step:'any'},
   {id:'end',label:'Show until',type:'number',min:0,max:duration,step:'any'},
   {id:'x',label:'Horizontal position',type:'number',min:0,max:1,step:'any'},
   {id:'y',label:'Vertical position',type:'number',min:0,max:1,step:'any'},
  ],
  precisionFields:['x','y'],
  actions:()=>[{id:'again',label:'Show again'},{id:'seek',label:'Go to text'}],
  onAction:(id,row,api)=>{if(id!=='again')return;const start=api.at();queueMicrotask(()=>api.append({...structuredClone(row),id:crypto.randomUUID(),start,end:Math.min(duration,start+row.end-row.start)}));},
  makeRow:start=>({id:crypto.randomUUID(),text:'Your text',start,end:Math.min(duration,start+2),x:.5,y:.8}),
  validate:row=>[row.start,row.end,row.x,row.y].every(Number.isFinite)&&row.start>=0&&row.end<=duration&&row.end>row.start&&row.x>=0&&row.x<=1&&row.y>=0&&row.y<=1,
  addLabel:'Add text at playhead',removeLabel:'Remove text'});
 return {...editor,updateDuration:next=>{duration=next;editor.updateDuration(next);},move:(id,position)=>editor.update(id,position)};
}
