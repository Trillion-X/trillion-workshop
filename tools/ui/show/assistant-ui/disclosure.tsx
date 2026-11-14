import React,{useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Accordion,AccordionItem,AccordionTrigger,AccordionContent} from './source/components/react/ui/base/accordion';

// Host existing form controls without replacing their values, events or owners.
export function mountDisclosure(node:HTMLElement,{title,content,open=false}:{title:string;content:HTMLElement;open?:boolean}){
  // The source theme belongs to the trigger, never to caller-owned form controls.
  node.classList.remove('source-conversation');
  const root=createRoot(node);
  let setExpanded:(value:string[])=>void=()=>{};
  let setLabel:(value:string)=>void=()=>{};
  function Content(){const host=useRef<HTMLDivElement>(null);useLayoutEffect(()=>{host.current?.append(content);},[]);return <div ref={host}/>;}
  function Disclosure(){const [value,setValue]=useState(open?['options']:[]),[label,updateLabel]=useState(title);setExpanded=setValue;setLabel=updateLabel;return <Accordion value={value} onValueChange={setValue}><AccordionItem value="options"><div className="source-conversation" data-layout="inline"><AccordionTrigger>{label}</AccordionTrigger></div><AccordionContent keepMounted><Content/></AccordionContent></AccordionItem></Accordion>;}
  flushSync(()=>root.render(<Disclosure/>));
  return {open:()=>flushSync(()=>setExpanded(['options'])),setTitle:(value:string)=>flushSync(()=>setLabel(value)),dispose:()=>root.unmount()};
}
