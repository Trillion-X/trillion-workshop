// frontends/web/src/packages/ui/code-block/CodeBlock.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Internal ui/ component for rendering syntax-highlighted code with Shiki.
// Handles the dangerouslySetInnerHTML rendering of Shiki HTML output.
// This is the ONLY place where <div> with dangerouslySetInnerHTML is allowed
// for code highlighting.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Content is pre-sanitized by Shiki (safe for innerHTML)
// 2. prose-content class applies Shiki token styling (from global.css @layer components)
// 3. Used internally by CodeRenderer and other renderers
// 4. ALL styling expressed via CVA variants — no raw className template literals
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// VARIANT DEFINITIONS
// ---------------------------------------------------------------------------

export const codeBlockVariants = cva(
  'prose-content text-xs font-mono text-[var(--text-secondary)] flex-1 overflow-x-auto whitespace-pre-wrap break-all',
  {
    variants: {},
    defaultVariants: {},
  },
);

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface CodeBlockProps extends VariantProps<typeof codeBlockVariants> {
  html: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function CodeBlock({ html, className }: CodeBlockProps) {
  return (
    <div
      className={cn(codeBlockVariants(), className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
