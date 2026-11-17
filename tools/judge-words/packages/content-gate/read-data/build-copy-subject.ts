// packages/content-gate/read-data/build-copy-subject.ts
//
// Purpose: Pure, generic helpers for constructing a GateSubject from raw text
// blocks or a plain string. Zero domain vocabulary — no customer, no page, no
// product references. Callers supply their own block kinds.
//
// Non-negotiable invariants:
//  - Pure functions: no I/O, no side effects, deterministic.
//  - `kind` is an open string (L090); these helpers enforce nothing about it.
//  - Empty-text blocks are filtered: a block with whitespace-only text adds no
//    signal and would skew length-bound evaluators.
//  - Additional properties on input blocks are forwarded onto ContentBlock via
//    spread so callers can annotate blocks with metadata (_page, id, etc.)
//    without losing them.

import type { ContentBlock, GateSubject } from './gate-types';

/**
 * Convert an array of {kind?, text, ...extra} objects into a GateSubject.
 * Blocks with empty or whitespace-only text are dropped.
 * `kind` defaults to "text" when absent.
 */
export function textBlocksToSubject(
  blocks: Array<{ kind?: string; text: string; [key: string]: unknown }>,
): GateSubject {
  const contentBlocks: ContentBlock[] = blocks.flatMap((b) => {
    if (!b.text || b.text.trim().length === 0) return [];
    const { kind, text, ...rest } = b;
    return [{ kind: kind ?? 'text', text, ...rest }];
  });
  return { blocks: contentBlocks };
}

/**
 * Wrap a plain string as a single-block GateSubject with kind "text".
 * Convenience for callers that have a single flattened copy string.
 */
export function plainTextToSubject(text: string): GateSubject {
  return { blocks: [{ kind: 'text', text }] };
}
