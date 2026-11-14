const finite=value=>Number.isFinite(Number(value));
export function mountMovableToolbar(node,{handle,initialPosition,onPositionChange,margin=8,viewport=window,portal=false}={}){
  if(!(node instanceof HTMLElement)||!(handle instanceof HTMLElement))throw new Error('Choose a toolbar and its move handle.');
  const originalParent=node.parentNode,originalNext=node.nextSibling;
  // A portaled toolbar floats above every pane, but it rests over the place it came from (its pane), never over a
  // neighbouring pane: its home's visible edges are handed to the look as --toolbar-home-start/--toolbar-home-end.
  // When its pane is raised above the page (a maximized or floating pane is a fixed layer with its own stacking), the
  // toolbar joins that layer, so it is never left underneath the pane it belongs to. Inside a layer that is a
  // containing block for fixed boxes (a transform or filter), edges and positions are measured from that layer.
  const home=portal&&originalParent instanceof Element?originalParent:null;
  const raisedLayer=()=>{let layer=null;for(let at=home;at&&at!==document.body&&at!==document.documentElement;at=at.parentElement)if(getComputedStyle(at).position==='fixed')layer=at;return layer;};
  const holdsFixed=element=>{if(!element)return false;const style=getComputedStyle(element);return style.transform!=='none'&&style.transform!==''||(style.filter||'none')!=='none'||(style.backdropFilter||style.webkitBackdropFilter||'none')!=='none'||(style.perspective||'none')!=='none'||/paint|layout|strict|content/.test(style.contain||'');};
  const frameOf=()=>{const parent=node.parentElement;if(parent&&parent!==document.body&&holdsFixed(parent)){const rect=parent.getBoundingClientRect();return {left:rect.left,top:rect.top,right:rect.right};}return {left:0,top:0,right:viewport.innerWidth||document.documentElement.clientWidth};};
  const settleHome=()=>{if(!home?.isConnected)return;const target=raisedLayer()||document.body;if(node.parentNode!==target)target.append(node);const rect=home.getBoundingClientRect(),frame=frameOf();node.style.setProperty('--toolbar-home-start',Math.max(0,rect.left-frame.left)+'px');node.style.setProperty('--toolbar-home-end',Math.max(0,frame.right-Math.min(frame.right,rect.right))+'px');};
  if(portal){node.dataset.movableToolbarPortal='';document.body.append(node);settleHome();}
  const homeObserver=home&&typeof ResizeObserver==='function'?new ResizeObserver(settleHome):null;homeObserver?.observe(home);
  let moved=false,drag=null,pendingInitial=finite(initialPosition?.x)&&finite(initialPosition?.y)?{x:Number(initialPosition.x),y:Number(initialPosition.y)}:null;
  const bounds=()=>({width:viewport.innerWidth||document.documentElement.clientWidth,height:viewport.innerHeight||document.documentElement.clientHeight});
  const clamp=(x,y)=>{const frame=bounds(),rect=node.getBoundingClientRect();return {x:Math.max(margin,Math.min(x,Math.max(margin,frame.width-rect.width-margin))),y:Math.max(margin,Math.min(y,Math.max(margin,frame.height-rect.height-margin)))};};
  const place=(x,y,{save=true}={})=>{const next=clamp(x,y);moved=true;node.dataset.moved='';const frame=portal?frameOf():{left:0,top:0};Object.assign(node.style,{position:'fixed',left:(next.x-frame.left)+'px',top:(next.y-frame.top)+'px',right:'auto',bottom:'auto',margin:'0'});if(save)onPositionChange?.(next);return next;};
  const reset=()=>{moved=false;delete node.dataset.moved;for(const property of ['position','left','top','right','bottom','margin'])node.style.removeProperty(property);onPositionChange?.(null);};
  const placeInitialWhenVisible=()=>{if(!pendingInitial)return false;const rect=node.getBoundingClientRect();if(!rect.width||!rect.height||node.hidden)return false;const position=pendingInitial;pendingInitial=null;place(position.x,position.y,{save:false});return true;};
  if(pendingInitial)requestAnimationFrame(placeInitialWhenVisible);
  const pointerDown=event=>{if(event.button!==0)return;const rect=node.getBoundingClientRect();drag={pointerId:event.pointerId,dx:event.clientX-rect.left,dy:event.clientY-rect.top};handle.setPointerCapture?.(event.pointerId);event.preventDefault();};
  const pointerMove=event=>{if(!drag||event.pointerId!==drag.pointerId)return;place(event.clientX-drag.dx,event.clientY-drag.dy,{save:false});event.preventDefault();};
  const pointerEnd=event=>{if(!drag||event.pointerId!==drag.pointerId)return;drag=null;handle.releasePointerCapture?.(event.pointerId);const rect=node.getBoundingClientRect();onPositionChange?.({x:rect.left,y:rect.top});};
  const keyDown=event=>{
    if(event.key==='Escape'&&moved){event.preventDefault();reset();return;}
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!direction)return;
    event.preventDefault();const rect=node.getBoundingClientRect(),step=event.shiftKey?1:12;place(rect.left+direction[0]*step,rect.top+direction[1]*step);
  };
  const resized=()=>{settleHome();if(placeInitialWhenVisible()||!moved)return;const rect=node.getBoundingClientRect();place(rect.left,rect.top,{save:false});};
  const sizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(resized):null;sizeObserver?.observe(node);
  const visibilityObserver=typeof MutationObserver==='function'?new MutationObserver(()=>requestAnimationFrame(resized)):null;visibilityObserver?.observe(node,{attributes:true,attributeFilter:['hidden','style','class']});
  handle.addEventListener('pointerdown',pointerDown);handle.addEventListener('pointermove',pointerMove);handle.addEventListener('pointerup',pointerEnd);handle.addEventListener('pointercancel',pointerEnd);handle.addEventListener('keydown',keyDown);viewport.addEventListener('resize',resized);
  return {place,reset,destroy(){sizeObserver?.disconnect();homeObserver?.disconnect();node.style.removeProperty('--toolbar-home-start');node.style.removeProperty('--toolbar-home-end');visibilityObserver?.disconnect();handle.removeEventListener('pointerdown',pointerDown);handle.removeEventListener('pointermove',pointerMove);handle.removeEventListener('pointerup',pointerEnd);handle.removeEventListener('pointercancel',pointerEnd);handle.removeEventListener('keydown',keyDown);viewport.removeEventListener('resize',resized);if(portal){delete node.dataset.movableToolbarPortal;if(originalParent?.isConnected)originalParent.insertBefore(node,originalNext?.parentNode===originalParent?originalNext:null);else node.remove();}}};
}
