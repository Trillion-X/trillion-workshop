// packages/ui/show/coss/record-editor.tsx
//
// Purpose: the one record editor for every screen; a screen that adds its own row editor repeats it. It is the one
// shared record editor (mountRecordEditor): rows of fields, each row a card with its actions, add,
// remove and reorder. Kept apart from workspace-controls.tsx, which re-exports it, so a screen that edits rows (the
// timed layers of a video) carries only the editor and not every other workspace control.
import React from 'react';
import {flushSync} from 'react-dom';
import {mountSharedContent} from './shared-content';
import {Button} from './ui/button';
import {ActionMenu} from '../action-menu';
import {Select,SelectTrigger,SelectValue,SelectPopup,SelectItem} from './ui/select';
import {Card,CardPanel,CardFooter} from './ui/card';
import {Checkbox} from './ui/checkbox';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';

const mount=mountSharedContent;

export function mountRecordEditor(node:HTMLElement,{items=[],fields,label,layout='stack',focused=false,selector=true,precisionFields=[],addLabel='Add',removeLabel='Remove',allowAdd=true,allowRemove=true,reorderable=false,moveUpLabel='Move up',moveDownLabel='Move down',minItems=0,maxItems=100,actions=[],onAction,onError,onSelectionChange,onChange}:any){
  let current=items.map((item:any)=>({...item})),serial=0,patchRow:((index:number,patch:any)=>void)|undefined,selectRow:((index:number)=>void)|undefined,moveRow:((from:number,to:number)=>void)|undefined;
  function Editor(){
    const [rows,setRows]=React.useState(()=>current.map((value:any)=>({key:serial++,value})));
    const [active,setActive]=React.useState(0);selectRow=setActive;
    const update=(next:any[])=>{current=next.map(row=>({...row.value}));setRows(next);};
    const move=(from:number,to:number)=>{if(from===to||from<0||to<0||from>=rows.length||to>=rows.length)return;const selected=rows[Math.min(active,rows.length-1)]?.key;const next=[...rows],row=next.splice(from,1)[0];next.splice(to,0,row);setActive(Math.max(0,next.findIndex(item=>item.key===selected)));update(next);};
    moveRow=move;
    patchRow=(index,patch)=>update(rows.map((row:any,i:number)=>i===index?{...row,value:{...row.value,...patch}}:row));
    React.useEffect(()=>{onSelectionChange?.(rows.length?Math.min(active,rows.length-1):null);},[active,rows]);
    React.useEffect(()=>{onChange?.(rows.map(row=>({...row.value})));},[rows]);
    const [pending,setPending]=React.useState<Set<number>>(new Set());
    const inFlight=React.useRef(new Set<number>());
    const runAction=async(row:any,action:any)=>{
      if(inFlight.current.has(row.key))return;inFlight.current.add(row.key);setPending(previous=>new Set(previous).add(row.key));
      try{const patch=await onAction?.(action.id,{...row.value});if(patch)setRows(previous=>{const next=previous.map(item=>item.key===row.key?{...item,value:{...item.value,...patch}}:item);current=next.map(item=>({...item.value}));return next;});}
      catch(error){onError?.(error);}
      finally{inFlight.current.delete(row.key);setPending(previous=>{const next=new Set(previous);next.delete(row.key);return next;});}
    };
    return <section className={`coss-record-editor coss-record-editor-${focused?'stack':layout}`} aria-label={label} onInvalidCapture={event=>{const target=event.target as HTMLElement;const card=target.closest('.coss-record-editor-row');const index=Array.from(event.currentTarget.querySelectorAll('.coss-record-editor-row')).indexOf(card as Element);if(index>=0)flushSync(()=>setActive(index));const details=target.closest('details');if(details)details.open=true;}}>
      {focused&&selector&&rows.length>1&&<select aria-label="Selected layer" value={Math.min(active,rows.length-1)} onChange={event=>setActive(Number(event.target.value))}>{rows.map((row:any,index:number)=><option key={row.key} value={index}>{row.value.name||`Layer ${index+1}`}</option>)}</select>}
      {rows.map((row:any,index:number)=><Card key={row.key} className="coss-record-editor-row" hidden={focused&&index!==Math.min(active,rows.length-1)} draggable={reorderable} onDragStart={reorderable?(event:any)=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-coss-record-row',String(row.key));}:undefined} onDragOver={reorderable?(event:any)=>{event.preventDefault();event.dataTransfer.dropEffect='move';}:undefined} onDrop={reorderable?(event:any)=>{event.preventDefault();const key=Number(event.dataTransfer.getData('application/x-coss-record-row')),from=rows.findIndex(item=>item.key===key);move(from,index);}:undefined}>
        <CardPanel className="coss-record-editor-fields">
        {[false,true].map(precise=>{const content=fields.filter((field:any)=>precisionFields.includes(field.id)===precise).map((field:any)=>{const change=(value:any)=>update(rows.map((item:any)=>item.key===row.key?{...item,value:{...item.value,[field.id]:value}}:item));const props={value:field.valueType==='array'&&Array.isArray(row.value[field.id])?row.value[field.id].join('\n'):row.value[field.id]??'',placeholder:field.placeholder,maxLength:field.maxLength,required:field.required,readOnly:field.readOnly,'aria-label':`${field.label} ${index+1}`,onChange:(event:any)=>change(['number','range'].includes(field.type)&&event.target.value!==''?Number(event.target.value):event.target.value)};const count=field.maxLength!==undefined?<small className="coss-record-field-count" aria-live="polite">{String(props.value).length} / {field.maxLength}</small>:null;return <label key={field.id} className={field.wide?'coss-record-field-wide':undefined}>{field.label}{field.displayOnly?<strong className="coss-record-field-value">{String(props.value)}</strong>:field.type==='checkbox'?<Checkbox checked={Boolean(row.value[field.id])} readOnly={field.readOnly} aria-label={`${field.label} ${index+1}`} onCheckedChange={change}/>:field.options?<Select value={String(row.value[field.id]??'')} onValueChange={change}><SelectTrigger aria-label={`${field.label} ${index+1}`}><SelectValue placeholder="Choose…">{field.options.find((option:any)=>option.value===String(row.value[field.id]??''))?.label}</SelectValue></SelectTrigger><SelectPopup portalProps={{className:'coss-ui'}}>{field.options.map((option:any)=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup></Select>:field.multiline?<><Textarea {...props} rows={field.rows||4}/>{count}</>:field.type==='range'?<input {...props} className="coss-record-range" type="range" min={field.min} max={field.max} step={field.step}/>:<Input {...props} type={field.type||'text'} min={field.min} max={field.max} step={field.step}/>}</label>;});// The key names the BRANCH of [false,true], never the shape that branch
// happened to render. Keying the fallback "primary" gave both passes the
// same key whenever there were no precision fields, and React is free to
// omit a duplicate-keyed child, which reads as a control that is simply
// missing from the form.
return precise&&content.length?<details key="precise" className="coss-record-precision"><summary>Precise values</summary>{content}</details>:<React.Fragment key={precise?'precise':'primary'}>{content}</React.Fragment>;})}
        </CardPanel><CardFooter>
        {focused?(()=>{const rowActions=(typeof actions==='function'?actions({...row.value}):actions) as any[];return <ActionMenu label={`Layer actions ${index+1}`}
          items={[...rowActions.map((action:any)=>({id:'action:'+action.id,label:action.label,icon:action.icon||'sparkles',group:'actions',disabled:pending.has(row.key)})),
            ...(reorderable&&index>0?[{id:'move-up',label:moveUpLabel,icon:'arrow-up',group:'order'}]:[]),
            ...(reorderable&&index<rows.length-1?[{id:'move-down',label:moveDownLabel,icon:'arrow-down',group:'order'}]:[]),
            ...(allowRemove&&rows.length>minItems?[{id:'remove',label:removeLabel,icon:'trash-2',group:'remove',tone:'destructive'}]:[])]}
          onAction={id=>{if(id==='move-up')move(index,index-1);else if(id==='move-down')move(index,index+1);else if(id==='remove')update(rows.filter((item:any)=>item.key!==row.key));else{const action=rowActions.find((candidate:any)=>'action:'+candidate.id===id);if(action)runAction(row,action);}}}/>;})():<>
        {(typeof actions==='function'?actions({...row.value}):actions).map((action:any)=><Button key={action.id} type="button" variant="outline" disabled={pending.has(row.key)} aria-label={`${action.label} ${index+1}`} onClick={()=>runAction(row,action)}>{action.label}</Button>)}
        {reorderable&&<><Button type="button" variant="outline" disabled={index===0} aria-label={`${moveUpLabel} ${index+1}`} onClick={()=>move(index,index-1)}>{moveUpLabel}</Button><Button type="button" variant="outline" disabled={index===rows.length-1} aria-label={`${moveDownLabel} ${index+1}`} onClick={()=>move(index,index+1)}>{moveDownLabel}</Button></>}
        {allowRemove&&<Button type="button" variant="outline" disabled={rows.length<=minItems} aria-label={`${removeLabel} ${index+1}`} onClick={()=>update(rows.filter((item:any)=>item.key!==row.key))}>{removeLabel}</Button>}
        </>}
        </CardFooter>
      </Card>)}
      {allowAdd&&<Button type="button" variant="outline" disabled={rows.length>=maxItems} onClick={()=>update([...rows,{key:serial++,value:Object.fromEntries(fields.map((field:any)=>[field.id,field.defaultValue??'']))}])}>{addLabel}</Button>}
    </section>;
  }
  mount(node,<Editor/>);return {updateFields:(next:any[])=>{fields=next;mount(node,<Editor/>);},move:(from:number,to:number)=>flushSync(()=>moveRow?.(from,to)),select:(index:number)=>{if(Number.isInteger(index)&&index>=0&&index<current.length)flushSync(()=>selectRow?.(index));},read:()=>current.map((item:any)=>({...item})),patch:(index:number,patch:any)=>{if(!Number.isInteger(index)||index<0||index>=current.length)throw Error('Choose an existing row.');flushSync(()=>patchRow?.(index,patch));}};
}
