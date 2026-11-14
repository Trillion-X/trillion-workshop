export function mountMarqueeSelection(node,{enabled=()=>true,onSelect,items='[data-record-id],.mw-card',idOf=null,skip='input,select,textarea,[role=menu],[data-item-action]'}={}){
  let start=null,box=null,moved=false,additive=false;
  const idFor=element=>idOf?idOf(element):element?.matches?.('[data-record-id]')?element.dataset.recordId:element?.querySelector?.('[data-preview]')?.dataset.preview;
  const finish=event=>{
    if(!start)return;
    window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',finish,true);window.removeEventListener('pointercancel',cancel,true);
    if(moved&&box){
      const bounds={left:Math.min(start.x,event.clientX),right:Math.max(start.x,event.clientX),top:Math.min(start.y,event.clientY),bottom:Math.max(start.y,event.clientY)},ids=[],elements=[];
      for(const item of node.querySelectorAll(items)){const rect=item.getBoundingClientRect(),id=idFor(item);if(id&&!ids.includes(id)&&rect.width>0&&rect.height>0&&rect.right>=bounds.left&&rect.left<=bounds.right&&rect.bottom>=bounds.top&&rect.top<=bounds.bottom){ids.push(id);elements.push(item);}}
      onSelect?.(ids,{additive,elements});
      window.addEventListener('click',suppress,{capture:true,once:true});
    }
    box?.remove();box=null;start=null;moved=false;
  };
  const cancel=()=>{box?.remove();box=null;start=null;moved=false;window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',finish,true);window.removeEventListener('pointercancel',cancel,true);};
  const suppress=event=>{event.preventDefault();event.stopImmediatePropagation();};
  const move=event=>{
    if(!start)return;const dx=event.clientX-start.x,dy=event.clientY-start.y;if(!moved&&Math.hypot(dx,dy)<6)return;
    moved=true;event.preventDefault();if(!box){box=document.createElement('div');box.className='coss-selection-marquee';document.body.append(box);}
    Object.assign(box.style,{left:Math.min(start.x,event.clientX)+'px',top:Math.min(start.y,event.clientY)+'px',width:Math.abs(dx)+'px',height:Math.abs(dy)+'px'});
  };
  const down=event=>{
    if(event.button!==0||!enabled())return;
    if(event.target.closest(skip))return;
    start={x:event.clientX,y:event.clientY};additive=event.metaKey||event.ctrlKey||event.shiftKey;moved=false;
    window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',finish,true);window.addEventListener('pointercancel',cancel,true);
  };
  node.addEventListener('pointerdown',down,true);
  return {destroy(){cancel();node.removeEventListener('pointerdown',down,true);}};
}
