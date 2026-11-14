import React,{useEffect,useRef,useState} from 'react';
import {useMotionValue, useTransform, animate, useReducedMotion, useDragControls} from 'framer-motion';
import { motion } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {Button} from '../coss/ui/button';

// Adapted from Cult UI's MIT three-d-carousel at 3b855612fb524cb042cc91b65f0cd575057471cc.
// Retains its cylinder faces, motion value and 3D rotation. Demo pictures and
// full-screen image overlay are replaced by caller content and discrete selection.
export function RotatingCarousel({items,renderItem,renderActiveAction,onActiveChange,initialId,label='Items'}:any){
 const [turn,setTurn]=useState(()=>Math.max(0,items.findIndex((item:any)=>item.id===initialId)));
 const count=items.length,index=count?((turn%count)+count)%count:0;
 const rotation=useMotionValue(0),reduced=useReducedMotion(),gesture=useRef(0),dragControls=useDragControls();
 const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(480);
 const latest=useRef(onActiveChange);latest.current=onActiveChange;
 const active=items[index]?.id;
 const requested=useRef(initialId);
 useEffect(()=>{if(requested.current===initialId)return;requested.current=initialId;const target=items.findIndex((item:any)=>item.id===initialId);if(target>=0)setTurn(target);},[initialId,items]);
 const cylinderWidth=width*Math.max(count,6),radius=cylinderWidth/(2*Math.PI);
 const transform=useTransform(rotation,value=>`translateZ(${-radius}px) rotate3d(0, 1, 0, ${value}deg)`);
 useEffect(()=>{const node=host.current;if(!node)return;const observer=new ResizeObserver(()=>setWidth(Math.min(480,Math.max(200,node.clientWidth-72))));observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(!count)return;const animation=animate(rotation,-turn*(360/count),{duration:reduced?0:.32,ease:[.32,.72,0,1]});return()=>animation.stop();},[turn,count,reduced,rotation]);
 useEffect(()=>{let live=true;queueMicrotask(()=>{if(live&&active)latest.current?.(active);});return()=>{live=false;};},[active]);
 if(!count)return null;
 const move=(delta:number)=>setTurn(value=>value+delta);
 return <section className="source-rotating-carousel" aria-label={label} aria-roledescription="carousel">
   <div ref={host} className="source-rotating-stage" tabIndex={0} aria-label="Browse items" onPointerDown={event=>{if(count>1)dragControls.start(event);}} onKeyDown={event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();event.currentTarget.focus();move(event.key==='ArrowRight'?1:-1);}}}>
     <motion.div className="source-rotating-cylinder" style={{transform,width:cylinderWidth}} drag={count>1?'x':false} dragControls={dragControls} dragListener={false} dragConstraints={{left:0,right:0}} dragElastic={0}
       onDragStart={()=>{gesture.current=rotation.get();}}
       onDrag={(_,info)=>{if(!reduced)rotation.set(gesture.current+info.offset.x*.12);}}
       onDragEnd={(_,info)=>{if(Math.abs(info.offset.x)>35){move(info.offset.x<0?1:-1);}else animate(rotation,-turn*(360/count),{duration:reduced?0:.2});}}>
       {items.map((item:any,i:number)=><div key={item.id} className="source-rotating-face" data-active={i===index?'true':'false'} data-carousel-item={item.id} inert={i!==index} aria-hidden={i!==index} style={{width,transform:`rotateY(${i*(360/count)}deg) translateZ(${radius}px)`}}>{renderItem(item)}</div>)}
     </motion.div>
   </div>
   {count>1&&<div className="source-rotating-controls"><Button variant="ghost" size="icon" aria-label="Previous item" onClick={()=>move(-1)}><ChevronLeft/></Button><span role="status" aria-live="polite">{index+1} / {count}</span><Button variant="ghost" size="icon" aria-label="Next item" onClick={()=>move(1)}><ChevronRight/></Button></div>}
   {renderActiveAction?.(items[index])}
 </section>;
}
