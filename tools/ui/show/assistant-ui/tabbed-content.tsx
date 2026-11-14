import React,{useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Tabs,TabsList,TabsTrigger,TabsContent} from './source/components/react/ui/base/tabs';

type Section={id:string;label:string;content:HTMLElement};
// Keep caller-owned inputs mounted while the licensed Tabs owns focus and selection.
export function mountTabbedContent(node:HTMLElement,{sections,label,initial,onChange}: {sections:Section[];label:string;initial?:string;onChange?:(id:string)=>void}){
  const root=createRoot(node);let select:(id:string)=>void=()=>{};
  function Contents({content}:{content:HTMLElement}){const host=useRef<HTMLDivElement>(null);useLayoutEffect(()=>{host.current?.append(content);},[content]);return <div ref={host}/>;}
  function View(){const [value,setValue]=useState(initial||sections[0]?.id);select=setValue;return <Tabs value={value} onValueChange={next=>{setValue(String(next));onChange?.(String(next));}} className="shared-tabbed-content">
    <div className="source-conversation shared-tabbed-navigation"><TabsList aria-label={label}>{sections.map(section=><TabsTrigger key={section.id} value={section.id}>{section.label}</TabsTrigger>)}</TabsList></div>
    {sections.map(section=><TabsContent key={section.id} value={section.id} keepMounted><Contents content={section.content}/></TabsContent>)}
  </Tabs>;}
  node.classList.add('shared-tabbed-host');
  flushSync(()=>root.render(<View/>));
  const invalid=(event:Event)=>{const index=sections.findIndex(section=>section.content.contains(event.target as Node));if(index>=0)flushSync(()=>select(sections[index].id));};
  node.addEventListener('invalid',invalid,true);
  return {select:(id:string)=>{if(sections.some(section=>section.id===id))flushSync(()=>select(id));},dispose:()=>{node.removeEventListener('invalid',invalid,true);root.unmount();}};
}
