// parts/ui/show/collection-header/mount-collection-header.tsx
//
// PURPOSE
//   The collection header drawn into a host element by a screen that is not React: `update` redraws it in place with
//   new props (a new title, one more person), `destroy` takes it away.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One React root per host; `update` re-renders that root, it never mounts a second one.
//   2. Unmounting waits a microtask, so a destroy called while React is drawing does not interrupt it.

import { createRoot } from 'react-dom/client';
import { CollectionHeader, type CollectionHeaderProps } from './CollectionHeader';

export type MountedCollectionHeader = { update: (props: CollectionHeaderProps) => void; destroy: () => void };

export function mountCollectionHeader(host: HTMLElement, props: CollectionHeaderProps): MountedCollectionHeader {
  const root = createRoot(host);
  const render = (next: CollectionHeaderProps) => root.render(<CollectionHeader {...next} />);
  render(props);
  return { update: render, destroy: () => queueMicrotask(() => root.unmount()) };
}
