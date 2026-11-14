// packages/ui/show/use-mark/use-mark-content.tsx
//
// PURPOSE
//   UseMark as content a record view can draw in a cell or over a card's
//   picture, with the provider-icon registry rows this package ships. Callers
//   pass only DATA (label, tone, icon, destinations, lines).
import React from 'react';
import uiManifest from '../../things-to-store-and-run.json';
import type {ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';
import {UseMark, type UseMarkProps} from './UseMark';

const providerIcons: ProviderIconRegistryRow[] = (uiManifest.things as any[]).filter(row => row.payload?.kind === 'provider-icon');

export function useMarkContent(options: Omit<UseMarkProps, 'registry'>) {
  return <UseMark registry={providerIcons} {...options}/>;
}
