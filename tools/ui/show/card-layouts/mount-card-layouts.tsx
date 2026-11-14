// packages/ui/show/card-layouts/mount-card-layouts.tsx
//
// PURPOSE
//   Mounts CardLayouts into any host a caller owns (pages that are not React).
//   Calling it again on the same host redraws with the new DATA; the returned
//   function releases the host.
import React from 'react';
import {mountSharedContent} from '../coss/shared-content';
import {releaseNode} from '../one-owner-per-node';
import {CardLayouts, type CardLayoutsOptions} from './CardLayouts';

export function mountCardLayouts(host: HTMLElement, options: CardLayoutsOptions): () => void {
  host.classList.add('card-layouts-host');
  mountSharedContent(host, <CardLayouts {...options}/>);
  return () => releaseNode(host);
}
