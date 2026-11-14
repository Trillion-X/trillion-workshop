import * as React from 'react';

import type {
  MediaWorkspaceSource,
  MediaWorkspaceView,
} from '../read-data/read-media-workspace';

export type OptimisticMediaPreview = {
  url: string;
  mediaType: string;
  label: string;
};

type OptimisticMediaItem = {
  source: MediaWorkspaceSource;
  preview?: OptimisticMediaPreview;
};

const optimisticItems = new Map<string, OptimisticMediaItem>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function snapshot() {
  return version;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function revokePreview(preview: OptimisticMediaPreview | undefined) {
  if (!preview?.url) return;
  try {
    URL.revokeObjectURL(preview.url);
  } catch {
    // URL ownership is best-effort because tests can stub object URLs.
  }
}

export function addOptimisticMediaWorkspaceSource(
  source: MediaWorkspaceSource,
  preview?: OptimisticMediaPreview,
) {
  revokePreview(optimisticItems.get(source.source_id)?.preview);
  optimisticItems.set(source.source_id, { source, preview });
  emit();
}

export function resetOptimisticMediaWorkspaceForTests() {
  for (const item of optimisticItems.values()) revokePreview(item.preview);
  optimisticItems.clear();
  emit();
}

export function useOptimisticMediaWorkspace(workspace: MediaWorkspaceView) {
  React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return React.useMemo(() => {
    const sourceById = new Map(workspace.sources.map((source) => [source.source_id, source]));
    const previewBySourceId: Record<string, OptimisticMediaPreview> = {};

    for (const [sourceId, item] of optimisticItems) {
      if (!sourceById.has(sourceId)) sourceById.set(sourceId, item.source);
      if (item.preview) previewBySourceId[sourceId] = item.preview;
    }

    const latestOptimisticSourceId = [...optimisticItems.keys()].at(-1);
    return {
      workspace: {
        ...workspace,
        sources: [...sourceById.values()],
        selectedSourceId: workspace.selectedSourceId ?? latestOptimisticSourceId,
      },
      previews: previewBySourceId,
    };
  }, [workspace, version]);
}
