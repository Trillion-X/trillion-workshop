// packages/ui/show/ask-bar/mount-ask-bar.tsx
//
// PURPOSE
//   Mounts AskBar into a DOM host for pages that are not React
//   (window.ExpansionControls.mountAskBar): one text field with a send button,
//   optional suggestions and optional extra actions. Calling it again with the
//   same host re-renders in place; the returned function unmounts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One React root per host, reused across calls.
//   2. Props pass through unchanged; the caller owns what a submit does.

import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AskBar, type AskBarProps } from './AskBar'

const roots = new WeakMap<HTMLElement, Root>()

export function mountAskBar(host: HTMLElement, props: AskBarProps): () => void {
  let root = roots.get(host)
  if (!root) {
    root = createRoot(host)
    roots.set(host, root)
  }
  root.render(React.createElement(AskBar, props))
  return () => {
    roots.get(host)?.unmount()
    roots.delete(host)
  }
}
