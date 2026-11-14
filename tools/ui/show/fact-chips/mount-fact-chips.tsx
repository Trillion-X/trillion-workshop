// packages/ui/show/fact-chips/mount-fact-chips.tsx
//
// Mounts FactChips into a DOM host for pages that are not React
// (window.ExpansionControls.mountFactChips). One root per host: calling it
// again re-renders in place; the returned function unmounts.
import React from 'react';
import {mountSharedContent} from '../coss/shared-content';
import {releaseNode} from '../one-owner-per-node';
import {FactChips, type FactChipsProps} from './FactChips';

export function mountFactChips(host: HTMLElement, props: FactChipsProps): () => void {
  host.classList.add('ui-fact-chips-host');
  mountSharedContent(host, <FactChips {...props}/>);
  return () => releaseNode(host);
}
