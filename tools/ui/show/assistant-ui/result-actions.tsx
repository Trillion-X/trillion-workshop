import React,{useState} from 'react';
import {Button} from './source/components/react/ui/base/button';

// Result identity and readiness belong to the caller's current-state owner.
// The unchanged licensed Button supplies focus, keyboard and disabled behavior.
export function ResultActions({items=[],label,onOpen}:any){
 const [opening,setOpening]=useState<string|null>(null);
 if(!items.length)return null;
 return <section aria-label={label} className="flex max-h-40 shrink-0 flex-col gap-2 overflow-y-auto border-t border-border p-3">{items.map((item:any)=><Button key={item.id} variant="outline" disabled={!item.available||opening!==null} onClick={async()=>{if(opening!==null)return;setOpening(item.id);try{await onOpen(item.id);}finally{setOpening(null);}}} aria-label={item.action+' '+item.title} data-result-id={item.id}><span className="truncate">{item.title}</span><span>{item.available?item.action:item.status}</span></Button>)}</section>;
}
