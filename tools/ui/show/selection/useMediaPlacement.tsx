import React from 'react';
import {readMediaDrag} from './media-drag-session.mjs';

export function useMediaPlacement({type,resolve,onDrop,duration,time,onSeek}:any){
 const [preview,setPreview]=React.useState<any>(null),origin=React.useRef<number|null>(null),pending=React.useRef(false);
 const callbacks=React.useRef({onSeek});callbacks.current={onSeek};
 const clear=React.useCallback((restore=true)=>{setPreview(null);if(restore&&origin.current!==null)callbacks.current.onSeek(origin.current);origin.current=null;},[]);
 React.useEffect(()=>{const ended=()=>{if(!pending.current)clear();};document.addEventListener('dragend',ended);return()=>document.removeEventListener('dragend',ended);},[clear]);
 const proposal=(event:any,surface:string)=>{
  const data=readMediaDrag(event.dataTransfer,type);if(!data)return null;
  const value=resolve?.(data);if(!value)return null;
  const rect=event.currentTarget.getBoundingClientRect();if(!rect.width||!rect.height)return null;
  const x=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y=Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));
  const start=Math.min(Math.max(0,duration-.01),surface==='timeline'?x*duration:Math.max(0,time));
  return {...value,data,surface,start,position:surface==='canvas'?{x,y}:undefined,duration:Math.min(duration-start,value.duration||5)};
 };
 const handlers=(surface:string)=>({
  onDragOver:(event:any)=>{if(pending.current)return;const next=proposal(event,surface);if(!next)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';if(origin.current===null)origin.current=time;setPreview(next);if(surface==='timeline')onSeek(next.start);},
  onDragLeave:(event:any)=>{if(!event.currentTarget.contains(event.relatedTarget)&&!pending.current)clear();},
  onDrop:async(event:any)=>{const next=proposal(event,surface);if(!next||pending.current)return;event.preventDefault();event.stopPropagation();pending.current=true;setPreview(next);try{await onDrop(next.data,next.start,next.position);}finally{pending.current=false;clear(false);}},
 });
 return {preview,timelineHandlers:handlers('timeline'),canvasHandlers:handlers('canvas')};
}
