// bitfield/packages/browser-shell/show/BrowserShell.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Thin browser-local root outlet.
// This CE component (component:browser-shell) is the browser entrypoint rendered
// after the SDK connection is established. It is not a control plane and does
// not import or mount Bitfield Studio packages.
//
// Durable feature truth stays in owner packages and addressed feeds. This shell
// does not coordinate work, discover packages, choose feature membership, compute
// summaries, or own feature data.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No imports from sibling packages
// 2. No package mounting
// 3. No feature lists, tab lists, membership rules, or setup data
// 4. No durable reads/writes
// 5. No routing policy or producer/consumer coordination
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

// ---------------------------------------------------------------------------
// BROWSER SHELL COMPONENT
// ---------------------------------------------------------------------------

export default function BrowserShell() {
  return (
    <div
      data-browser-shell-root
      style={{
        minHeight: '100%',
        width: '100%',
        background: 'var(--black-pure, #050505)',
        color: 'var(--text-primary, #f5f5f5)',
      }}
    />
  );
}
