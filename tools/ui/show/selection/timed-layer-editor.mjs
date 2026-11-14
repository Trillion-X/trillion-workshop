// Timed layers (text, adjustments, timed looks) are rows placed on a video
// timeline. Every kind is edited through the one shared record editor: the
// kind supplies its fields, actions, new-row shape and bounds as data, and
// this owner keeps the rows, the selection and the timeline-facing API.
import {mountRecordEditor} from '../coss/record-editor.tsx';
import {createControl} from '../coss/dom-controls.tsx';

export function mountTimedLayerEditor(host,{layers=[],label,fields,precisionFields=[],actions=()=>[],onAction,makeRow,validate=()=>true,addLabel,emptyLabel,removeLabel='Remove',duration,getTime,onChange,onEdit,onSeek,timelineDriven=false}){
 const fieldsFor=row=>typeof fields==='function'?fields(row):fields;
 const withDefaults=row=>{const out={...row};for(const field of fieldsFor(row))if(out[field.id]===undefined&&field.defaultValue!==undefined)out[field.id]=field.defaultValue;return out;};
 let rows=structuredClone(layers).map(withDefaults),selected=rows[0]?.id??null,editor=null,signature='',shape='';
 host.classList.add('timed-layer-editor');
 const recordHost=document.createElement('div'),empty=document.createElement('p'),add=createControl('button');
 empty.className='timed-layer-empty';empty.textContent=emptyLabel||'';add.type='button';add.textContent=addLabel;
 host.replaceChildren(recordHost,empty,add);
 const commit=()=>{signature=JSON.stringify(rows);onChange?.(structuredClone(rows));};
 const indexOf=id=>rows.findIndex(row=>row.id===id);
 const shapeOf=row=>JSON.stringify([fieldsFor(row||{}).map(field=>field.id),actions(row||{}).map(action=>action.id)]);
 const paint=()=>{
  if(indexOf(selected)<0)selected=rows[0]?.id??null;
  // The row to show is read before mounting: the editor reports its first row as selected while it mounts, and
  // that report would otherwise replace the choice being painted.
  const target=indexOf(selected),current=rows[target];
  signature=JSON.stringify(rows);shape=shapeOf(current);
  empty.hidden=!emptyLabel||rows.length>0;
  editor=mountRecordEditor(recordHost,{label,items:rows,fields:fieldsFor(current||{}),focused:true,selector:!timelineDriven,precisionFields,allowAdd:false,removeLabel,reorderable:true,actions,
   onAction:async(id,row)=>{onSeek&&id==='seek'?onSeek(row.start):onAction?.(id,row,api);return null;},
   onSelectionChange:index=>{if(index==null||!rows[index])return;selected=rows[index].id;if(shapeOf(rows[index])!==shape)queueMicrotask(paint);},
   onChange:next=>{const value=JSON.stringify(next);if(value===signature)return;onEdit?.();if(next.length&&!next.every(row=>validate(row)))return;rows=next.map(row=>({...row}));commit();}});
  if(rows.length)editor.select(target);
 };
 const at=()=>Math.max(0,Math.min(duration-.1,Number(getTime?.()||0)));
 add.onclick=()=>{const row=makeRow(at());if(!row)return;rows.push(withDefaults(row));selected=row.id;commit();paint();};
 const api={
  read:()=>structuredClone(rows),
  at,
  // Refresh bounds without rebuilding the record editor: it may hold an unfinished field value and selection.
  updateDuration(next){if(duration===next)return;duration=next;editor.updateFields(fieldsFor(rows[indexOf(selected)]||{}));},
  select(id){if(indexOf(id)<0)return;selected=id;paint();},
  append(row){rows.push(withDefaults(row));selected=row.id;commit();paint();return rows.length-1;},
  reorder(from,to){if(!rows[from]||!rows[to]||from===to)return;const [row]=rows.splice(from,1);rows.splice(to,0,row);selected=row.id;commit();paint();},
  patch(index,values){if(!rows[index])return;Object.assign(rows[index],values);commit();if(rows[index].id===selected&&shapeOf(rows[index])!==shape)paint();else editor.patch(index,values);},
  update(id,values){const index=indexOf(id);if(index<0)return;Object.assign(rows[index],values);const changed=selected!==id;selected=id;commit();if(changed)paint();else editor.patch(index,values);},
  remove(index){if(!rows[index])return null;const [row]=rows.splice(index,1);commit();paint();return row;},
  restore(index,row){rows.splice(Math.min(index,rows.length),0,withDefaults(structuredClone(row)));selected=row.id;commit();paint();},
  destroy(){host.replaceChildren();},
 };
 paint();
 return api;
}
