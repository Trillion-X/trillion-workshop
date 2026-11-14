// frontends/web/src/packages/ui/markdown-block/MarkdownBlock.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Internal ui/ component for rendering parsed markdown HTML with Shiki
// syntax-highlighted code blocks. Handles the dangerouslySetInnerHTML
// rendering of parsed markdown output.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Content is pre-sanitized by parseMarkdown/parseMarkdownAsync (safe for innerHTML)
// 2. prose-content class applies markdown styling (from global.css @layer components)
// 3. Used internally by MarkdownRenderer and other components
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

export const markdownBlockVariants = cva(
  'prose-content max-w-none break-words text-[var(--text-strong)]',
  {
    variants: {},
    defaultVariants: {},
  },
);

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface MarkdownBlockProps extends VariantProps<typeof markdownBlockVariants> {
  html: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function MarkdownBlock({ html, className }: MarkdownBlockProps) {
  return (
    <div
      className={cn(markdownBlockVariants(), className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
