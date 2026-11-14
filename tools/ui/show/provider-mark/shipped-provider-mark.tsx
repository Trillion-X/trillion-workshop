// parts/ui/show/provider-mark/shipped-provider-mark.tsx
//
// PURPOSE
//   The mark of a provider this part ships an icon for (shipped-provider-icons.ts), or `fallback` when it ships none.
//   Fetched by LazyShippedProviderMark (lazy-provider-mark.tsx) the first time a card draws one, since the shipped
//   icons are tens of kilobytes the page's first screen does not need.
import React from 'react';
import { ProviderMark, type ProviderMarkProps } from './ProviderMark';
import { resolveProviderMark } from './provider-icon-registry';
import { providerIconRegistry } from './shipped-provider-icons';

export type ShippedProviderMarkProps = { providerSlug: string; providerName?: string; size?: ProviderMarkProps['size']; needsImage?: boolean; fallback: React.ReactNode };

export default function ShippedProviderMark({ providerSlug, providerName, size, needsImage = false, fallback }: ShippedProviderMarkProps) {
  const known = resolveProviderMark({ providerSlug, providerName }, providerIconRegistry);
  if (!known || (needsImage && !known.image)) return <>{fallback}</>;
  return <ProviderMark providerSlug={known.providerSlug} providerName={known.providerName} registry={providerIconRegistry} size={size} />;
}
