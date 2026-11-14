// package-set://bitfield-studio/packages/product-access/ios-jscore/product-access-proof-entry.ts

import { readProductAccessView } from '../read-data/read-product-access';
import { mapProductAccessViewToSurfaceDescriptor } from '../show/map-product-access-surface';
import type { ProductAccessSurfaceDescriptor } from '../show/product-access-surface-descriptor';

export function buildProductAccessSurfaceDescriptor(): ProductAccessSurfaceDescriptor {
  return mapProductAccessViewToSurfaceDescriptor(readProductAccessView());
}

export function staleDescriptorFixture(): ProductAccessSurfaceDescriptor {
  const descriptor = buildProductAccessSurfaceDescriptor();
  return {
    ...descriptor,
    sections: descriptor.sections.map((section) => {
      if (section.kind === 'itemList') {
        return {
          ...section,
          items: section.items.map((item) => ({
            ...item,
            primaryAction: item.primaryAction
              ? { ...item.primaryAction, enabled: false, disabledReason: 'Reconnect before running actions' }
              : undefined,
            secondaryActions: item.secondaryActions.map((action) => ({
              ...action,
              enabled: false,
              disabledReason: 'Reconnect before running actions',
            })),
          })),
        };
      }
      if (section.kind === 'itemDetail') {
        return {
          ...section,
          actions: section.actions.map((action) => ({
            ...action,
            enabled: false,
            disabledReason: 'Reconnect before running actions',
          })),
        };
      }
      if (section.kind === 'error' && section.retry) {
        return {
          ...section,
          retry: { ...section.retry, enabled: false, disabledReason: 'Reconnect before running actions' },
        };
      }
      return section;
    }),
  };
}
