// packages/ui/show/expandable-tabs/mount-expandable-tabs.tsx
//
// PURPOSE
//   Mounts ExpandableTabs into a DOM host for non-React pages (for example
//   window.ExpansionControls.mountExpandableTabs). Re-calling with the same
//   host re-renders in place; the returned function unmounts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One React root per host, reused across calls.
//   2. Props are passed through unchanged; this file adds no behavior.

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ExpandableTabs, type ExpandableTabsProps } from './ExpandableTabs'

const roots = new WeakMap<HTMLElement, Root>()

export function mountExpandableTabs(host: HTMLElement, props: ExpandableTabsProps): () => void {
  let root = roots.get(host)
  if (!root) {
    root = createRoot(host)
    roots.set(host, root)
  }
  root.render(React.createElement(ExpandableTabs, props))
  return () => {
    roots.get(host)?.unmount()
    roots.delete(host)
  }
}
