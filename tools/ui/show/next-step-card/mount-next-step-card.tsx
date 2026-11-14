// parts/ui/show/next-step-card/mount-next-step-card.tsx
//
// PURPOSE
//   Mounts the shared NextStepCard into any host a caller owns. Calling it
//   again on the same host redraws with the new DATA; the returned function
//   releases it. Destinations draw with the provider-icon rows this part
//   ships unless the caller hands its own registry.
import React from 'react';
import {mountSharedContent} from '../coss/shared-content';
import {releaseNode} from '../one-owner-per-node';
import {providerIconRegistry} from '../provider-mark/shipped-provider-icons';
import {NextStepCard, type NextStepCardProps} from './NextStepCard';

export function mountNextStepCard(host: HTMLElement, props: Omit<NextStepCardProps, 'registry'> & {registry?: NextStepCardProps['registry']}): () => void {
  host.classList.add('next-step-card-host');
  mountSharedContent(host, <NextStepCard {...props} registry={props.registry ?? providerIconRegistry}/>);
  return () => releaseNode(host);
}
