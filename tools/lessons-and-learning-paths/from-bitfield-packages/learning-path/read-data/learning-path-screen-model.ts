// packages/learning-path/read-data/learning-path-screen-model.ts
// Pure projection: a journey feed -> the learning-path screen model (resolved
// PathRail node views + header + empty flag). Status presentation lives in a DATA
// overrides map (default below, overridable by the feed); icons resolve by name.
// No closed status enum, no domain vocabulary baked into logic (L090/L063).

import {
  decodePathNodes,
  type PathNodeView,
  type PathStatusOverrides,
} from '@/packages/ui/show/path-rail';

export interface LearningPathScreenModel {
  title: string;
  nodes: PathNodeView[];
  isEmpty: boolean;
}

// Default status presentation as DATA. The feed may supply its own overrides to
// replace/extend this without any code change (a new status = one more entry).
export const DEFAULT_STATUS_OVERRIDES: PathStatusOverrides = {
  complete: { toneColor: 'var(--status-success)', complete: true },
  active: { toneColor: 'var(--status-info)', ring: true, bubble: 'START' },
  available: { toneColor: 'var(--status-info)' },
  locked: { toneColor: 'var(--text-muted)', dimmed: true },
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function mergeOverrides(feed: Record<string, unknown>): PathStatusOverrides {
  const fromFeed = feed.statusOverrides;
  if (fromFeed && typeof fromFeed === 'object' && !Array.isArray(fromFeed)) {
    return { ...DEFAULT_STATUS_OVERRIDES, ...(fromFeed as PathStatusOverrides) };
  }
  return DEFAULT_STATUS_OVERRIDES;
}

/**
 * Build the screen model from the raw journey feed. The feed carries an optional
 * `title`, the `nodes` rows, and optional `statusOverrides`. An `iconResolver`
 * (name -> icon component) is injected by the surface. Pure + total: a feed with
 * no nodes yields an empty model (the surface shows an honest empty state).
 */
export function buildLearningPathScreenModel(
  raw: unknown,
  iconResolver?: (iconName?: string) => PathNodeView['icon'],
): LearningPathScreenModel {
  const feed = asObject(raw);
  // A bare array IS the node rows; otherwise read feed.nodes (decoder also
  // accepts the whole feed object as a fallback).
  const nodesInput = Array.isArray(raw) ? raw : (feed.nodes ?? feed);
  const nodes = decodePathNodes(nodesInput, {
    statusOverrides: mergeOverrides(feed),
    iconResolver,
  });
  return {
    title: readString(feed.title),
    nodes,
    isEmpty: nodes.length === 0,
  };
}
