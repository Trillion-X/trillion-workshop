// packages/group/read-data/board-to-capsule-source.ts
//
// Gather a board's FULL tree (root items + every nested section's descendants) into the flat,
// world-space CapsuleSourceItem[] that `buildShareCapsule` scopes into a share link. This is the
// SHARE twin of the EXPORT flattening (`flattenBoardTree`, board-tree.ts): a section's children
// carry world-space rectangles, so a flat list renders at the correct positions and the section
// item itself stays in the list as a labeled folder box. Without this, a share built from a single
// `readItems` level dropped every nested note (Codex share-audit #2).
//
// Each descendant carries `sectionId` = the id of its ENCLOSING section, so the 'section' scope
// AND the section-closure in `buildShareCapsule` (a kept section brings its whole subtree) both
// work without the capsule needing a recursive tree — the board already stores children in world
// space, so a flat list is the faithful representation.
//
// Pure fold over `readItems` — no I/O, no React, no DOM. Mirrors `flattenBoardTree`'s recursion
// but additionally threads the enclosing-section id (which the export flatten does not need).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { AddressRef, GroupGraph } from '../../ui/show/group/group-graph';
import { walkTree } from './board-tree';
import type { CapsuleSourceItem } from './share-capsule';

/**
 * Flatten the board tree under `rootRef` into the world-space source the share codec consumes.
 * A section item appears in the list (so it renders as a folder box) AND recurses into its
 * children, each tagged with the section's member id as `sectionId`.
 *
 * Reuses the SHARED cycle-safe {@link walkTree} (the export-flatten SSOT) rather than its own
 * recursion, so a corrupted/persisted CYCLIC section nesting can no longer hang the share build
 * (a store.load()-hydrated graph bypasses the write-path cycle guard — see walkTree). `walkTree`
 * threads the enclosing-section id, which is exactly the `sectionId` this flatten needs.
 */
export function boardToCapsuleSource(graph: GroupGraph, rootRef: AddressRef): CapsuleSourceItem[] {
  const out: CapsuleSourceItem[] = [];
  walkTree(graph, rootRef, (it, _parentRef, enclosingSectionId) => {
    const extra = (it.extra ?? {}) as Record<string, unknown>;
    out.push({
      memberId: it.memberId,
      kind: it.kind,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      text: it.text,
      html: it.html,
      src: it.src,
      extra: it.extra,
      // Section folder metadata for the opener's folder-box render.
      isSection: it.isSection ? true : undefined,
      childCount: it.isSection ? it.childCount : undefined,
      // Scope linkage: the enclosing section (undefined at the root) + self-describing scope fields
      // the resolvers read (tags for the 'tag' scope, kind for the 'type' scope).
      sectionId: enclosingSectionId,
      tags: Array.isArray(extra.tags) ? (extra.tags as string[]) : undefined,
      itemKind: it.kind,
    });
    return undefined; // collect every item; never stop early
  });
  return out;
}
