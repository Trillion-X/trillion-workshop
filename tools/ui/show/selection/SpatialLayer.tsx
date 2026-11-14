import React from 'react';

// Normalized geometry is shared by preview and export; no edit is saved here.
export function SpatialLayer({value,label,selected,onSelect,onChange,children}:any){
 const gesture=React.useRef<any>(null);
 const start=(event:any,resize=false)=>{if(event.button!==0||!onChange)return;event.preventDefault();event.stopPropagation();const node=resize?event.currentTarget.parentElement:event.currentTarget;const parent=node.parentElement.getBoundingClientRect(),rect=node.getBoundingClientRect();gesture.current={x:event.clientX,y:event.clientY,value:{x:value.x,y:value.y,scale:value.scale},parent,rect,resize};event.currentTarget.setPointerCapture(event.pointerId);onSelect?.();};
 const move=(event:any)=>{const g=gesture.current;if(!g)return;const dx=event.clientX-g.x,dy=event.clientY-g.y;
  if(g.resize){const factor=1+2*(dx*g.rect.width+dy*g.rect.height)/(g.rect.width**2+g.rect.height**2);onChange({scale:Math.max(.02,Math.min(1,g.value.scale*factor))});}
  else onChange({x:Math.max(0,Math.min(1,g.value.x+dx/g.parent.width)),y:Math.max(0,Math.min(1,g.value.y+dy/g.parent.height))});
 };
 const finish=()=>{gesture.current=null;};const cancel=()=>{if(gesture.current)onChange(gesture.current.value);finish();};
 return <div className="live-composition-layer spatial-layer" data-selected={selected?'':undefined} role="button" tabIndex={0} aria-label={label} style={{left:value.x*100+'%',top:value.y*100+'%',width:value.scale*100+'%',opacity:value.opacity}} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect?.();return;}const amount=event.shiftKey?.05:.01,steps:any={ArrowLeft:[-amount,0],ArrowRight:[amount,0],ArrowUp:[0,-amount],ArrowDown:[0,amount]};if(steps[event.key]){event.preventDefault();onSelect?.();onChange?.({x:Math.max(0,Math.min(1,value.x+steps[event.key][0])),y:Math.max(0,Math.min(1,value.y+steps[event.key][1]))});}}}>
  {children}
  {selected&&onChange&&<span role="slider" tabIndex={0} className="spatial-layer-resize" aria-label="Resize selected media" aria-valuemin={2} aria-valuemax={100} aria-valuenow={Math.round(value.scale*100)} onPointerDown={event=>start(event,true)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();onChange({scale:Math.max(.02,Math.min(1,value.scale+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1)*(event.shiftKey?.05:.01)))});}}/>}
 </div>;
}
