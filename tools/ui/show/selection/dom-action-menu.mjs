// DOM action-menu adapter. Uses the existing Button variant contract and
// BeautifulUI SelectionActions' primary/more hierarchy (MIT; ../BeautifulUI-LICENSE.txt).
// Actions and real effects remain consumer-owned. No demo state.
export function enhanceActionSelect(select, label='More actions') {
  if(!select || select.dataset.menuBound)return;
  select.dataset.menuBound='true';select.hidden=true;
  const host=document.createElement('details');host.className='ui-action-menu';
  const trigger=document.createElement('summary');trigger.textContent=label;trigger.setAttribute('aria-label',label);trigger.setAttribute('aria-haspopup','menu');
  const menu=document.createElement('div');menu.className='ui-menu-items';menu.setAttribute('role','menu');host.append(trigger,menu);select.after(host);
  const close=()=>{host.open=false;trigger.focus();};
  for(const option of select.options){if(!option.value)continue;const button=document.createElement('button');button.type='button';button.textContent=option.textContent;button.disabled=option.disabled;button.setAttribute('role','menuitem');button.onclick=()=>{select.value=option.value;close();select.dispatchEvent(new Event('change',{bubbles:true}));};menu.append(button);}
  host.addEventListener('keydown',e=>{const items=[...menu.querySelectorAll('button:not(:disabled)')],i=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();close();}if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();host.open=true;items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}});
  host.addEventListener('focusout',()=>queueMicrotask(()=>{if(!host.contains(document.activeElement))host.open=false;}));
  host.addEventListener('toggle',()=>trigger.setAttribute('aria-expanded',String(host.open)));
  return host;
}
