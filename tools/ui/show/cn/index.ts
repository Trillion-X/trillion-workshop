// bitfield-studio/frontends/web/packages/ui/cn/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Tailwind CSS class name utility for conditional class merging. Uses clsx for
// conditional logic and tailwind-merge to resolve conflicting utility classes.
// This is the SINGLE SOURCE OF TRUTH for class merging in the Bitfield Studio.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses clsx for conditional class logic
// 2. Uses tailwind-merge to resolve conflicting Tailwind classes
// 3. Always prefer this over string concatenation for class names
// 4. Canonical source for class merging (no duplicates)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges Tailwind CSS classes intelligently.
 *
 * Combines clsx for conditional logic with tailwind-merge for
 * resolving conflicting utility classes.
 *
 * @param inputs - Class values (strings, arrays, objects)
 * @returns Merged class string with conflicts resolved
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
