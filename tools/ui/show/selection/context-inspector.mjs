// Caller-owned controls stay mounted, preserving form values and playback.
// The section picker is the shared icon-tab control (ExpandableTabs): each
// section is an icon that shows its full name on hover, focus or while chosen.
// Sections are DATA: {id, label, icon (NamedIcon name), host, available?}.
import {mountExpandableTabs} from '../expandable-tabs/mount-expandable-tabs.tsx';

export function mountContextInspector(host,{sections,initialId,onSelect}){
 host.classList.add('context-inspector');
 const nav=document.createElement('div');nav.className='context-inspector-tabs';host.append(nav);
 const available=new Map(sections.map(section=>[section.id,section.available!==false]));let current;
 const draw=()=>mountExpandableTabs(nav,{mode:'choice',size:'sm',ariaLabel:'Editing tools',value:current,onChange:id=>select(id),items:sections.filter(section=>available.get(section.id)).map(({id,label,icon})=>({id,label,icon}))});
 const select=id=>{
  if(!sections.some(section=>section.id===id&&available.get(section.id)))return;
  current=id;
  for(const section of sections)section.host.hidden=section.id!==id;
  draw();
  for(let parent=host.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(/auto|scroll/.test(style.overflowY)&&parent.scrollHeight>parent.clientHeight){parent.scrollTop=Math.max(0,parent.scrollTop+host.getBoundingClientRect().top-parent.getBoundingClientRect().top-8);break;}}
  onSelect?.(id);
 };
 for(const section of sections){section.host.classList.add('context-inspector-panel');section.host.setAttribute('role','group');section.host.setAttribute('aria-label',section.label);host.append(section.host);}
 const invalid=event=>{const section=sections.find(section=>section.host.contains(event.target));if(section)select(section.id);};host.addEventListener('invalid',invalid,true);
 select(initialId||sections.find(section=>available.get(section.id))?.id);
 return {select,setAvailable(id,value){if(!available.has(id))return;available.set(id,value);if(!value&&current===id){const fallback=sections.find(section=>available.get(section.id));if(fallback){select(fallback.id);return;}}draw();},get selected(){return current;},destroy(){host.removeEventListener('invalid',invalid,true);nav.replaceChildren();}};
}
