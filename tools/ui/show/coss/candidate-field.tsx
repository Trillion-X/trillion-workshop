import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ArrowLeft,ArrowRight,MoreHorizontal} from 'lucide-react';
import {ExpandableTabs} from '../expandable-tabs/ExpandableTabs';
import {Button} from './ui/button';
import {Card} from './ui/card';
import {Checkbox} from './ui/checkbox';
import {ActionMenu} from '../action-menu';

export type Candidate={id:string;title:string;text?:string;kind:string;category:string;poster?:string;playable?:boolean;actions?:{id:string;label:string;icon:string}[]};
type Options={items:Candidate[];selected:string[];layout:string;filter:string;activeId?:string;loading?:boolean;error?:string;hasMore?:boolean;onSelect:(id:string,checked:boolean)=>void;onOpen:(id:string)=>void;onPreview?:(id:string,host:HTMLElement)=>(()=>void)|void;onAction:(id:string,action:string)=>void;onFilter:(filter:string)=>void;onLayout:(layout:string)=>void;onActive:(id:string)=>void;onMore:()=>void;onRetry:()=>void;onSelectionAction:(action:string)=>void};
function Preview({item}:{item:Candidate}){const [failed,setFailed]=useState(false);return item.poster&&!failed?<img src={item.poster} alt="" loading="lazy" onError={()=>setFailed(true)}/>:null;}
function Playback({item,onPreview}:{item:Candidate;onPreview:Options['onPreview']}){const host=useRef<HTMLDivElement>(null);useEffect(()=>{if(host.current)return onPreview?.(item.id,host.current);},[item.id]);return <div ref={host} className="candidate-playback"/>;}
function Neighbors({items,active,selected,onActive}:{items:Candidate[];active:number;selected:Set<string>;onActive:(id:string)=>void}){
 const rail=useRef<HTMLDivElement>(null);
 useEffect(()=>{const node=rail.current,button=node?.children[active] as HTMLElement;if(!node||!button)return;const left=button.offsetLeft-node.offsetLeft-(node.clientWidth-button.offsetWidth)/2;node.scrollTo({left,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});},[active,items.length]);
 return <nav className="candidate-neighbors" aria-label="Nearby options"><Button variant="ghost" size="icon" aria-label="Previous option" disabled={active===0} onClick={()=>onActive(items[active-1].id)}><ArrowLeft size={18}/></Button><div ref={rail} className="candidate-neighbor-rail" onKeyDown={event=>{const index=Array.from(event.currentTarget.children).indexOf(event.target as Element);if(index<0)return;const target=event.key==='ArrowRight'?Math.min(items.length-1,index+1):event.key==='ArrowLeft'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?items.length-1:-1;if(target<0)return;event.preventDefault();onActive(items[target].id);(event.currentTarget.children[target] as HTMLElement).focus({preventScroll:true});}}>{items.map((item,index)=><Button key={item.id} variant="ghost" className="candidate-neighbor" aria-label={'Focus option '+(index+1)+': '+item.title} aria-current={index===active?'true':undefined} data-selected={selected.has(item.id)||undefined} title={item.title} onClick={()=>onActive(item.id)}>{item.poster?<Preview item={item}/>:<span>{item.title}</span>}{selected.has(item.id)&&<span className="candidate-neighbor-mark" aria-label="Selected">✓</span>}</Button>)}</div><Button variant="ghost" size="icon" aria-label="Next option" disabled={active===items.length-1} onClick={()=>onActive(items[active+1].id)}><ArrowRight size={18}/></Button></nav>;
}
/** A toolbar item that opens the shared ActionMenu: the item's own button is the trigger. */
const menuTrigger=(label:string,items:{id:string;label:string;icon:string}[],onAction:(id:string)=>void)=>(button:React.ReactElement)=><ActionMenu label={label} trigger={button} triggerContent={(button.props as {children?:React.ReactNode}).children} items={items} onAction={onAction}/>;
function Field({value:v}:{value:Options}){
 const visible=v.items.filter(item=>v.filter==='All'||item.category===v.filter),active=Math.max(0,visible.findIndex(item=>item.id===v.activeId)),shown=v.layout==='single'?visible.slice(active,active+1):visible,chosen=new Set(v.selected);
 const categories=['All',...new Set(v.items.map(item=>item.category))];
 const collection=useRef<HTMLDivElement>(null),previousLayout=useRef(v.layout);
 useEffect(()=>{if(v.layout==='grid'&&previousLayout.current==='single'){const card=Array.from(collection.current?.children||[]).find(node=>(node as HTMLElement).dataset.candidateId===v.activeId);card?.scrollIntoView({block:'nearest',behavior:'instant'});}previousLayout.current=v.layout;},[v.layout,v.activeId]);
 return <section className="candidate-field" aria-label="Creative options">
  <header className="candidate-field-header"><ExpandableTabs mode="action" size="sm" ariaLabel="Option view" items={[...(categories.length>2?[{id:'filter',label:'Filter options',icon:'sliders-horizontal',detail:v.filter==='All'?undefined:v.filter,pinned:v.filter!=='All',wrap:menuTrigger('Filter options',categories.map(category=>({id:category,label:category,icon:'list-filter'})),category=>v.onFilter(category))}]:[]),{id:'layout',label:v.layout==='single'?'Compare options':'One at a time',icon:v.layout==='single'?'grid-2x2':'square'}]} onSelect={id=>{if(id==='layout')v.onLayout(v.layout==='single'?'grid':'single');}}/></header>
  {v.error&&<div role="alert">{v.error} <Button variant="ghost" onClick={v.onRetry}>Try again</Button></div>}
  {!visible.length&&<p className="candidate-empty" role="status">{v.loading?'Loading your options…':v.filter==='All'?'Ask for a few directions. They’ll appear here.':'No '+v.filter.toLowerCase()+' in these options.'}</p>}
  <div ref={collection} className="candidate-collection" data-layout={v.layout}>{shown.map(item=><Card key={item.id} className="candidate-card" data-candidate-id={item.id} data-current={item.id===v.activeId||undefined} data-category={item.category} data-selected={chosen.has(item.id)||undefined}>
   <Checkbox className="candidate-pick" aria-label={'Select '+item.title} data-pick={item.id} checked={chosen.has(item.id)} onCheckedChange={checked=>v.onSelect(item.id,checked===true)}/>
   {v.layout==='single'?<div className="candidate-content">{item.playable?<Playback item={item} onPreview={v.onPreview}/>:<Preview item={item}/>}<h3>{item.title}</h3>{item.text&&<p>{item.text}</p>}</div>:<Button variant="ghost" className="candidate-open candidate-content" aria-label={item.title} onClick={()=>v.onOpen(item.id)}><Preview item={item}/><h3>{item.title}</h3>{item.text&&<p>{item.text}</p>}</Button>}
   {!!item.actions?.length&&<div className="candidate-menu"><ActionMenu label={'Options for '+item.title} trigger={<Button variant="ghost" size="icon"/>} triggerContent={<MoreHorizontal size={18}/>} items={item.actions} onAction={id=>v.onAction(item.id,id)}/></div>}
  </Card>)}</div>
  {v.layout==='single'&&visible.length>1&&<Neighbors items={visible} active={active} selected={chosen} onActive={v.onActive}/>}
  {v.hasMore&&<Button variant="ghost" disabled={v.loading} onClick={v.onMore}>Load more</Button>}
  {!!chosen.size&&<div className="candidate-selection" role="group" aria-label="Selected options"><span role="status">{chosen.size} selected</span><ExpandableTabs mode="action" size="sm" ariaLabel="Selection" items={[{id:'clear',label:'Clear selection',icon:'x'},{id:'actions',label:'Selection actions',icon:'more-horizontal',wrap:menuTrigger('Selection actions',[{id:'refine',label:'Refine selected',icon:'wand-sparkles'},...(chosen.size>1?[{id:'merge',label:'Combine',icon:'merge'}]:[]),{id:'create',label:'Create from selected',icon:'plus'}],id=>v.onSelectionAction(id))}]} onSelect={id=>{if(id==='clear')v.onSelectionAction('clear');}}/></div>}
 </section>;
}
/** Uses the pinned MIT Coss controls; application owns records, requests and selection. */
export function mountCandidateField(node:HTMLElement,options:Options){const root=createRoot(node);node.classList.add('coss-ui');const update=(value:Options)=>flushSync(()=>root.render(<Field value={value}/>));update(options);return {update,dispose:()=>root.unmount()};}
