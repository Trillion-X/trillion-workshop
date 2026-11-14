// parts/ui/show/provider-mark/lazy-provider-mark.tsx
//
// PURPOSE
//   A provider's shipped mark for a card (listing-card) without loading the shipped icons with the page: `fallback`
//   (the person's picture, their initials or the card's icon) shows until the icons arrive, and stays when the
//   provider has none.
import React from 'react';
import { lazyPart } from '../load-later/later';
import type { ShippedProviderMarkProps } from './shipped-provider-mark';

const ShippedProviderMark = lazyPart(() => import('./shipped-provider-mark'), module => module.default);

export function LazyShippedProviderMark(props: ShippedProviderMarkProps) {
  return <React.Suspense fallback={props.fallback}><ShippedProviderMark {...props} /></React.Suspense>;
}
