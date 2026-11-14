import React,{useEffect,useRef} from 'react';
import {GripVertical,Sparkles,X,ChevronUp} from 'lucide-react';
import {mountMovableToolbar} from '../selection/movable-toolbar.mjs';
import {reserveBottomFloatingInset} from '../floating-occlusion/reserve-bottom-inset';
import {Button} from './ui/button';
import {Card} from './ui/card';
import {ActionMenu} from '../action-menu';

export type ActionPromptItem={id:string;label:string;icon:string;onAction:()=>void|Promise<void>};
export type ActionPromptOptions={
  id?:string;
  title?:string;
  summary?:string;
  actions?:ActionPromptItem[];
  collapsed?:boolean;
  initialPosition?:{x:number;y:number}|null;
  onOpen?:()=>void|Promise<void>;
  onCollapsedChange?:(collapsed:boolean)=>void;
  onPositionChange?:(position:{x:number;y:number}|null)=>void;
};

export function ActionPrompt({id,title='What now?',summary='Useful next actions',actions=[],collapsed=false,initialPosition,onOpen,onCollapsedChange,onPositionChange}:ActionPromptOptions){
  const frame=useRef<HTMLElement|null>(null),handle=useRef<HTMLButtonElement|null>(null),positionChange=useRef(onPositionChange);
  positionChange.current=onPositionChange;
  useEffect(()=>{
    if(!frame.current||!handle.current)return;
    return mountMovableToolbar(frame.current,{handle:handle.current,initialPosition,onPositionChange:value=>positionChange.current?.(value)}).destroy;
  },[]);
  useEffect(()=>frame.current?reserveBottomFloatingInset(frame.current):undefined,[]);
  const primary=actions.slice(0,1),overflow=actions.slice(1);
  return <Card render={<aside id={id} ref={frame} aria-label={title}/>} className="coss-action-prompt" data-collapsed={collapsed?'':undefined}>
    <Button ref={handle} variant="ghost" size="icon-sm" className="coss-action-prompt-handle" aria-label={`Move ${title}`} title="Drag to move · Arrow keys to move · Escape to reset"><GripVertical aria-hidden="true"/></Button>
    <Button variant="ghost" className="coss-action-prompt-open" aria-label="Open ideas and actions" onClick={onOpen}>
      <span className="coss-action-prompt-mark" aria-hidden="true"><Sparkles/></span>
      <span className="coss-action-prompt-copy"><small>{title}</small><strong title={summary}>{summary}</strong></span>
    </Button>
    <span className="coss-action-prompt-actions">{primary.map(item=><Button key={item.id} variant="secondary" size="sm" title={item.label} onClick={()=>item.onAction()}><span className="coss-action-prompt-label">{item.label}</span></Button>)}</span>
    {overflow.length?<ActionMenu label="More useful actions" align="end" side="top" trigger={<Button type="button" variant="secondary" size="icon-sm" className="coss-action-prompt-more"/>} triggerContent={<ChevronUp/>} items={overflow} onAction={id=>overflow.find(item=>item.id===id)?.onAction()}/>:null}
    <Button type="button" variant="ghost" size="icon-sm" className="coss-action-prompt-collapse" aria-label={collapsed?`Expand ${title}`:`Collapse ${title}`} onClick={()=>onCollapsedChange?.(!collapsed)}>{collapsed?<Sparkles/>:<X/>}</Button>
  </Card>;
}
