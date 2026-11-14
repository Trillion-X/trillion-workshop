// parts/ui/show/coss/shared-content.tsx
//
// Purpose
//   Draws shared components into a node the page owns (`mountSharedContent`): one React root per node, claimed so a
//   previous writer on the node tears down first, and released when the node leaves the page. Kept apart from the
//   control mounts in workspace-controls.tsx (which re-exports it), so a screen state draws without loading them.
import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {claimNode,releaseNode} from '../one-owner-per-node';

const roots=new WeakMap<HTMLElement,Root>();
/** What tears down a mount's own listeners when its node is released (workspace-controls.tsx sets these). */
export const disposers=new WeakMap<HTMLElement,()=>void>();
let watching=false;
export function mountSharedContent(node:HTMLElement,content:React.ReactNode){
  node.classList.add('coss-ui');
  // Claiming before creating the root lets any previous writer on this node
  // tear down while the DOM still matches what it rendered. Without it, the
  // other writer's replaceChildren() left this root holding references to
  // deleted children and the next render threw on removeChild.
  let root=roots.get(node);if(!root){
    claimNode(node,()=>{const held=roots.get(node);if(!held)return;roots.delete(node);disposers.get(node)?.();disposers.delete(node);held.unmount();});
    root=createRoot(node);roots.set(node,root);
  }
  flushSync(()=>root!.render(content));
  if(!watching){watching=true;new MutationObserver(records=>{
    for(const record of records)for(const removed of record.removedNodes)if(removed instanceof HTMLElement)queueMicrotask(()=>{
      if(removed.isConnected)return;
      // Both markers, because a detached subtree can hold either kind of
      // writer and leaving the other mounted leaks a React root per removal.
      // releaseNode runs whichever one claimed the node and knows how to undo
      // itself, so this loop does not need to know which that was.
      for(const candidate of [removed,...removed.querySelectorAll<HTMLElement>('[data-shared-root],[data-record-views-host]')]) releaseNode(candidate);
    });
  }).observe(document.body,{childList:true,subtree:true});}
  node.dataset.sharedRoot='true';
}
