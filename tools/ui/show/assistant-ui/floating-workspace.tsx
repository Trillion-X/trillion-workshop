import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Rnd} from 'react-rnd';
import {Button} from './source/components/react/ui/base/button';

// MIT react-rnd owns pointer/touch dragging and resizing. Docking is layout
// integration; children remain in the same mounted subtree in every position.
export function FloatingWorkspace({children,title,actions,onClose,onDockChange,storageKey='floating-workspace'}:any){
 const viewport=()=>({width:window.innerWidth,height:window.innerHeight});
 const floating=useRef<Rnd>(null);
 const [measured,setMeasured]=useState(false);
 const [view,setView]=useState(viewport),[dock,setDock]=useState<'left'|'right'|null>(null);
 const [frame,setFrame]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved&&['x','y','width','height'].every(k=>Number.isFinite(saved[k])))return saved;}catch{}return {x:Math.max(8,innerWidth-504),y:Math.max(8,innerHeight-660),width:480,height:620};});
 const gap=8,width=Math.max(240,Math.min(frame.width,view.width-gap*2)),height=Math.max(240,Math.min(frame.height,view.height-gap*2));
 const size={width,height:dock?view.height-gap*2:height};
 const position=measured?{x:dock==='left'?gap:dock==='right'?Math.max(gap,view.width-width-gap):Math.max(gap,Math.min(frame.x,view.width-width-gap)),y:dock?gap:Math.max(gap,Math.min(frame.y,view.height-height-gap))}:{x:0,y:0};
 // A hidden parent has no geometry. Starting at zero prevents react-rnd from
 // subtracting the saved position as a false parent offset during its mount.
 useLayoutEffect(()=>{const parent=floating.current?.getSelfElement()?.parentElement;if(!parent)return;const resize=()=>{if(parent.clientWidth&&parent.clientHeight){setView({width:parent.clientWidth,height:parent.clientHeight});setMeasured(true);}};const observer=new ResizeObserver(resize);observer.observe(parent);resize();return()=>observer.disconnect();},[]);
 useEffect(()=>{localStorage.setItem(storageKey,JSON.stringify(frame));},[frame,storageKey]);
 useEffect(()=>{onDockChange?.(dock,dock?width:0);return()=>onDockChange?.(null,0);},[dock,width,onDockChange]);
 const move=(event:React.KeyboardEvent)=>{if(!event.key.startsWith('Arrow'))return;event.preventDefault();setDock(null);const step=event.shiftKey?40:10;setFrame({...frame,x:position.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),y:position.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)});};
 return <Rnd ref={floating} className="source-floating-workspace" size={size} position={position} bounds="parent" minWidth={Math.min(320,view.width-gap*2)} minHeight={Math.min(320,view.height-gap*2)} maxWidth={view.width-gap*2} maxHeight={view.height-gap*2} dragHandleClassName="source-floating-handle" cancel="button" enableResizing={!dock} onDragStart={()=>setDock(null)} onDragStop={(_,data)=>{setFrame({...frame,x:data.x,y:data.y});if(data.x<=gap+12)setDock('left');else if(data.x+width>=view.width-gap-12)setDock('right');}} onResizeStop={(_,__,element,___,next)=>setFrame({x:next.x,y:next.y,width:element.offsetWidth,height:element.offsetHeight})}>
   <section className="source-floating-panel" aria-label={title||'Conversation'} data-dock={dock||'floating'}>
    <header className="source-floating-header">
     <div className="source-floating-handle" role="button" tabIndex={0} aria-label="Move conversation. Use arrow keys to move." onKeyDown={move}>{title}</div>
     <div className="source-floating-actions">{actions}<Button variant="ghost" size="icon" aria-label="Dock conversation left" onClick={()=>setDock('left')}>⇤</Button><Button variant="ghost" size="icon" aria-label={dock?'Float conversation':'Dock conversation right'} onClick={()=>setDock(dock?null:'right')}>{dock?'↗':'⇥'}</Button><Button variant="ghost" size="icon" aria-label="Close conversation" onClick={onClose}>×</Button></div>
    </header>
    <div className="source-floating-content">{children}</div>
   </section>
 </Rnd>;
}

// Keep upstream attachment presentation; the app supplies its real picker.
export function AttachmentOwner({children,onAttach}:any){
 return <div className="source-attachment-owner" onClickCapture={event=>{if(!(event.target as HTMLElement).closest('.aui-composer-add-attachment')||!onAttach)return;event.preventDefault();event.stopPropagation();onAttach();}}>{children}</div>;
}
