// frontends/web/src/packages/ui/image-block/ImageBlock.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ui/ wrapper for <img> elements with CVA variants for objectFit, maxHeight,
// and borderRadius. Eliminates raw <img> with inline styles throughout feature
// code — the ONLY place where <img> renders in the design system.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL image styling expressed via CVA variants or well-typed props
// 2. maxHeight passed as style prop (dynamic value, no CVA variant needed)
// 3. All native img attributes forwarded via ...props
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

// max-w-full is a base truth, not a variant: an image must NEVER exceed its
// container width (a wide natural-resolution image otherwise pushes its flex
// ancestors past the viewport). Height is capped per-instance via maxHeight.
export const imageBlockVariants = cva('max-w-full', {
  variants: {
    objectFit: {
      contain: 'object-contain',
      cover:   'object-cover',
      fill:    'object-fill',
      none:    'object-none',
    },
    rounded: {
      none: '',
      sm:   'rounded-sm',
      md:   'rounded-md',
      lg:   'rounded-lg',
      xl:   'rounded-xl',
      full: 'rounded-full',
    },
    width: {
      auto: 'w-auto',
      full: 'w-full',
    },
  },
  defaultVariants: {
    objectFit: 'contain',
    rounded:   'lg',
    width:     'auto',
  },
});

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export type ImageBlockProps = VariantProps<typeof imageBlockVariants> & {
  /** Dynamic max height (e.g. "24rem"). Passed as inline style since CVA cannot encode arbitrary values. */
  maxHeight?: string;
  src?: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  loading?: 'eager' | 'lazy';
};

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ImageBlock({
  objectFit,
  rounded,
  width,
  maxHeight,
  className,
  style,
  ...props
}: ImageBlockProps) {
  return (
    <img
      className={cn(imageBlockVariants({ objectFit, rounded, width }), className)}
      style={maxHeight ? { maxHeight, ...style } : style}
      {...props}
    />
  );
}
