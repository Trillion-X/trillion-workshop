// packages/screen-arrangement/read-data/worker-console-arrangement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build a single-container, multi-TAB `LayoutState` from a DATA-declared tab
// list, where every tab mounts a package surface SCOPED to one subject (an AI
// worker / agent / any record) via a shared `subjectInput` merged into each
// tab's `metadata.surfaceInput`.
//
// This is the generative primitive behind the "click a board node -> open an
// embedded tabbed console" feature: the board hands this builder (1) a DATA tab
// list (which package surface each tab mounts) and (2) the clicked subject's
// identity (worker_id / agent_ref / ...). The builder returns a plain
// `LayoutState` the EmbeddedScreenArrangement renders. It names NO package, NO
// agent, NO "console" concept — a container of tabs is the only physics here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure data — no React, no I/O, no side effects.
// 2. NO domain vocabulary: the tab list + subjectInput are opaque DATA. This
//    builder works identically for support agents, poker bots, or CI runners.
// 3. Deterministic tab ids (slug of the DATA `id`, no Date.now()/Math.random())
//    so the SAME (subject, tabs) always yields byte-identical state — resume-
//    safe, dedupe-stable, and diff-friendly for persistence.
// 4. `subjectInput` is merged UNDER any per-tab `surfaceInput`, so a tab can add
//    its own keys (e.g. a default filter) without losing the subject scoping —
//    per-tab keys win on collision.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { EMPTY_TAB_TITLE, type LayoutState, type TabMeta } from './layout-types';

/**
 * One DATA-declared console tab: a package surface (packageName + entryName) plus
 * its human title/icon. Lives in a surface config record, never in engine code.
 * `surfaceInput` is a per-tab addition merged OVER the shared subject input.
 */
export interface WorkerConsoleTabSpec {
  /** Stable slug seed for the tab id (e.g. 'profile', 'runs', 'chat', 'work'). */
  id: string;
  /** Human tab label shown in the strip. */
  title: string;
  /** Icon name from the ui icon registry. Falls back to 'Square'. */
  icon?: string;
  /** Package that owns the surface this tab mounts. */
  packageName: string;
  /** Entry name of the surface this tab mounts. */
  entryName: string;
  /** Per-tab surfaceInput keys, merged OVER the shared subjectInput. */
  surfaceInput?: Record<string, unknown>;
}

function slug(seed: string): string {
  return (
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'tab'
  );
}

/**
 * Build a tabbed `LayoutState` — one container, one tab group holding the DATA
 * tabs in order, first tab active. Each tab carries its `packageEntry` +
 * `metadata.surfaceInput` (subjectInput merged with any per-tab keys), the SAME
 * shape `tabPatchForPlaceableSurface` produces — so the LayoutEngine renders it
 * through the identical package-surface path.
 *
 * An EMPTY tab list yields a single empty tab (never an empty tab group, which
 * would leave the container with no active tab and render blank).
 */
export function buildWorkerConsoleLayout(
  tabs: readonly WorkerConsoleTabSpec[],
  subjectInput: Record<string, unknown>,
): LayoutState {
  const tabIds: string[] = [];
  const tabMetas: Record<string, TabMeta> = {};
  const usedIds = new Set<string>();

  for (const spec of tabs) {
    const base = `wc-${slug(spec.id)}`;
    // Guard against two DATA tabs sharing a slug (would collide the tab id and
    // silently drop one). Suffix on collision, deterministically.
    let id = base;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    usedIds.add(id);
    tabIds.push(id);
    tabMetas[id] = {
      id,
      title: spec.title,
      target: null,
      packageEntry: { packageName: spec.packageName, entryName: spec.entryName },
      materialTarget: null,
      icon: spec.icon ?? 'Square',
      closable: false,
      metadata: {
        surfaceInput: { ...subjectInput, ...(spec.surfaceInput ?? {}) },
      },
    };
  }

  if (tabIds.length === 0) {
    const emptyId = 'wc-empty';
    tabIds.push(emptyId);
    tabMetas[emptyId] = { id: emptyId, title: EMPTY_TAB_TITLE, target: null, icon: 'Square' };
  }

  return {
    containers: { main: { id: 'main', groupId: 'main-group' } },
    tabGroups: { 'main-group': { tabIds, activeTabId: tabIds[0] } },
    tabs: tabMetas,
    layouts: [
      { type: 'tiled', root: { kind: 'leaf', containerId: 'main' } },
      { type: 'floating', containers: [], camera: { scale: 1, tx: 0, ty: 0 } },
      { type: 'overlay', containers: [] },
    ],
    surface: 'grid',
    focusedContainerId: 'main',
    maximizedContainerId: null,
  };
}
