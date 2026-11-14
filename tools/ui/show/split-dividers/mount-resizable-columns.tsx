import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SplitDividers} from './SplitDividers';

/** Adds the existing shared divider to a CSS-grid workspace without remounting its content. */
export function mountResizableColumns(host:HTMLElement,{container,initialWidth=320,onChange}:{container:HTMLElement;initialWidth?:number;onChange?:(width:number)=>void}){
 function Divider(){
  const [size,setSize]=useState({width:container.clientWidth,height:container.clientHeight}),[width,setWidth]=useState(initialWidth),start=useRef(initialWidth);
  const minimum=240,maximum=Math.max(minimum,Math.min(640,size.width*.6));
  const apply=(value:number)=>{const next=Math.round(Math.max(minimum,Math.min(maximum,value)));setWidth(next);container.style.setProperty('--conversation-width',next+'px');onChange?.(next);};
  useEffect(()=>{const observer=new ResizeObserver(()=>setSize({width:container.clientWidth,height:container.clientHeight}));observer.observe(container);return()=>observer.disconnect();},[]);
  useEffect(()=>{container.style.setProperty('--conversation-width',Math.max(minimum,Math.min(maximum,width))+'px');},[width,maximum]);
  const current=Math.max(minimum,Math.min(maximum,width));
  return <SplitDividers axis="x" revealed label="Resize conversation" value={{now:current,min:minimum,max:maximum}} dividers={[{leftIndex:0,rightIndex:1,left:current+8,top:0,width:16,height:size.height}]} onResizeStart={()=>{start.current=current;}} onResize={(_left,_right,delta)=>apply(start.current+delta)} onResizeStep={direction=>apply(direction==='reset'?320:direction==='minimum'?minimum:direction==='maximum'?maximum:current+(direction==='increase'?24:-24))}/>;
 }
 const root=createRoot(host);flushSync(()=>root.render(<Divider/>));return {dispose:()=>root.unmount()};
}
