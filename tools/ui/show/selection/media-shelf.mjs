// One persistent library with explicit categories; panels keep their selections
// and playback owners when the person switches categories.
export function mountMediaShelf(host,{tabs,initialId,onSelect}){
 host.classList.add('media-shelf');const nav=document.createElement('div');nav.className='media-shelf-tabs';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Media library');host.append(nav);const buttons=new Map();
 const select=id=>{for(const tab of tabs){const active=tab.id===id,button=buttons.get(tab.id);tab.host.hidden=!active;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}onSelect?.(id);};
 for(const tab of tabs){const button=document.createElement('button');button.type='button';button.textContent=tab.label;button.setAttribute('role','tab');button.setAttribute('aria-label',tab.ariaLabel||tab.label);const id='media-'+crypto.randomUUID();button.id=id;tab.host.setAttribute('role','tabpanel');tab.host.setAttribute('aria-labelledby',id);button.onclick=()=>select(tab.id);button.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const index=tabs.indexOf(tab),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;select(tabs[next].id);buttons.get(tabs[next].id).focus();};buttons.set(tab.id,button);nav.append(button);host.append(tab.host);}
 select(initialId||tabs[0]?.id);return {select,destroy(){host.replaceChildren();}};
}
