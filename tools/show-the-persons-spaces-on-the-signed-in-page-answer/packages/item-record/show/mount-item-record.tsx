// package://packages/item-record/show/mount-item-record.tsx
//
// Browser-local mount entry for the ItemFeed surface.
// Passes all mount props through to ItemFeed, including `target_ref` /
// `targetRef` so callers (e.g. group-page) can scope the feed to a group.

import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui';
import { ItemFeed } from '@/packages/item-record/show/ItemFeed';

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <ItemFeed {...props} />, props, 'item-record material');
}
