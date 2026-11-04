// Vendored unchanged except for import paths from bitfield-packages/packages/learning-path/read-data/project-progress-to-path.ts.
// packages/learning-path/read-data/project-progress-to-path.ts
// Projects a caller-ready progress view into the learning-path feed. This
// package owns its caller-language contract and never reads another owner's
// storage rows or imports another package's source.

export type LearningPathProgressView = {
  title: string;
  steps: Array<{
    id: string;
    label: string;
    sortOrder: number;
    completed: boolean;
    current: boolean;
  }>;
};

export interface PathFeed {
  title: string;
  nodes: Array<{ id: string; label: string; status: string }>;
}

function stepStatus(step: LearningPathProgressView['steps'][number]): string {
  if (step.completed) return 'complete';
  if (step.current) return 'active';
  return 'locked';
}

/**
 * Build the path feed from one caller-ready focus view. Steps are ordered by
 * sortOrder; status comes from the view's completed/current booleans.
 * With no view / no steps the feed is empty (the surface shows an honest empty
 * state). Pure + total.
 */
export function projectProgressToPath(view: LearningPathProgressView | null | undefined): PathFeed {
  if (!view || !Array.isArray(view.steps)) return { title: '', nodes: [] };

  const ordered = [...view.steps].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return {
    title: view.title ?? '',
    nodes: ordered.map((step) => ({
      id: step.id,
      label: step.label,
      status: stepStatus(step),
    })),
  };
}
