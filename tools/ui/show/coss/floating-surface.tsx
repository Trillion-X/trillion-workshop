// parts/ui/show/coss/floating-surface.tsx
//
// Purpose
//   The frame every floating panel draws (`FloatingPanelFrame`: grab bar, scroll area, header, body, live regions) and
//   the rule that transient floating surfaces are exclusive (`claimFloatingSurface`). Kept apart from the control
//   mounts in workspace-controls.tsx (which re-exports both), so a floating panel draws without loading them.
import React from 'react';
import {FloatingGrab} from '../floating-grab/FloatingGrab';

// Transient floating surfaces (menus, anchored panels) are exclusive: opening
// one closes whichever is already open, so they never stack over each other.
export type FloatingSurface={close:()=>void};
let activeFloatingSurface:FloatingSurface|null=null;
export function claimFloatingSurface(surface:FloatingSurface){
  const previous=activeFloatingSurface;activeFloatingSurface=surface;
  if(previous&&previous!==surface)previous.close();
}
export function releaseFloatingSurface(surface:FloatingSurface){if(activeFloatingSurface===surface)activeFloatingSurface=null;}

// The inside of a floating panel: a grab strip (move) with a close button, an
// optional title and one-line description, the body (React children, or filled
// by an imperative caller) and, when asked, two live regions. The window around it (placement, dragging, resizing) belongs to the
// arrangement that hosts it. It is a non-modal dialog: never aria-modal, never
// a backdrop, and the page behind it stays usable.
export type FloatingPanelRefs={element?:HTMLElement;body?:HTMLElement;status?:HTMLElement;alert?:HTMLElement;content?:HTMLElement;grab?:HTMLElement};
export function FloatingPanelFrame({label,title,description,labelledBy,describedBy,liveRegions=true,closeAs,refs,onGrab,onClose,children}:{label:string;title?:string;description?:string;labelledBy?:string;describedBy?:string;liveRegions?:boolean;closeAs?:{label:string;icon:string};refs:FloatingPanelRefs;onGrab:(event:React.PointerEvent)=>void;onClose:()=>void;children?:React.ReactNode}){
  return <section ref={node=>{if(node)refs.element=node;}} role="dialog" aria-label={labelledBy?undefined:label} aria-labelledby={labelledBy} aria-describedby={describedBy} className="coss-ui coss-floating-panel">
    <FloatingGrab label={label} onGrab={onGrab} onClose={onClose} closeAs={closeAs} grabRef={node=>{if(node)refs.grab=node;}}/>
    <div className="coss-floating-panel-scroll"><div ref={node=>{if(node)refs.content=node;}} className="coss-floating-panel-content">
      {(title||description)&&<header className="coss-floating-panel-header">{title&&<h2 className="coss-floating-panel-title">{title}</h2>}{description&&<p className="coss-floating-panel-description">{description}</p>}</header>}
      <div ref={node=>{if(node)refs.body=node;}} className="coss-floating-panel-body">{children}</div>
      {liveRegions&&<><p ref={node=>{if(node)refs.status=node;}} role="status"/><p ref={node=>{if(node)refs.alert=node;}} role="alert"/></>}
    </div></div>
  </section>;
}

