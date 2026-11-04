// parts/guided-overlay/show/mount-walkthrough-host.tsx
//
// The part's entry: mounts the always-on WalkthroughHost once at the app shell. It
// renders nothing until a host event starts a tour, and portals its spotlight and
// coachmark to <body> at the walkthrough layer, so the element it is given can be an
// empty, hidden host. The app hands it the tours it ships as DATA, its words for every
// tour (End tour, the step shown when one is ended early) and its owner-readback bridge.

import React, {useEffect, useRef, useState} from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { WalkthroughHost } from './WalkthroughHost';
import type { OwnerSignalBridge, WalkthroughWords } from './WalkthroughSurface';
import {currentPresentationRows} from '../../ui/show/request/current-presentation-rows.mjs';

type Presentation = {words?:WalkthroughWords;ownerSignalBridge?:OwnerSignalBridge};

type MountArgs = {
  el: HTMLElement;
  /** The tours, the app's words for every tour, and how a step reads a fact its owner keeps (owner-readback). */
  props: { definitions: unknown; words?: WalkthroughWords; ownerSignalBridge?: OwnerSignalBridge;
    presentationSource?:(current:()=>void)=>Promise<Presentation>;
    subscribe?:(changed:()=>Promise<void>)=>(()=>void);
  };
};

const missingFacts:OwnerSignalBridge=async refs=>Object.fromEntries(refs.map(ref=>[ref,null]));
function CurrentHost({props}:{props:MountArgs['props']}){
  const [presentation,setPresentation]=useState<Presentation|null>(()=>props.presentationSource?null:props);
  const generation=useRef(0);
  useEffect(()=>{
    if(!props.presentationSource)return;
    const rows=currentPresentationRows({rows:null,clearBeforeRefresh:true,subscribe:props.subscribe,
      source:()=>{const mine=++generation.current;return props.presentationSource!(()=>{if(mine!==generation.current)throw new Error('The tour presentation changed.');});},
      onRows:(next:Presentation|null)=>{if(!next)generation.current++;setPresentation(next);},
      failed:(error:unknown)=>console.warn('Tour presentation could not be read.',error),
    });
    return()=>{generation.current++;rows.stop();};
  },[props.presentationSource,props.subscribe]);
  const selected=props.presentationSource?presentation:props;
  return <WalkthroughHost definitions={props.definitions} words={selected?.words} ownerSignalBridge={props.presentationSource?(selected?.ownerSignalBridge??missingFacts):props.ownerSignalBridge}/>;
}

export default function mountWalkthroughHost({ el, props }: MountArgs) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="guided-overlay host">
      <CurrentHost props={props} />
    </ErrorBoundary>,
  );
}
