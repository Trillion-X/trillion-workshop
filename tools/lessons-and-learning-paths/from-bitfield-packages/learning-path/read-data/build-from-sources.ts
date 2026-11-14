// packages/learning-path/read-data/build-from-sources.ts
// Builds the screen model from caller-ready progress views and local fallback
// presentation. It never decodes a sibling owner's storage records.

import {
  projectProgressToPath,
  type LearningPathProgressView,
} from '../../../../community-logic/src/community-logic/project-progress-to-path.ts';
import {
  buildLearningPathScreenModel,
  type LearningPathScreenModel,
} from './learning-path-screen-model.ts';
import type { PathNodeView } from '@/packages/ui/show/path-rail';

export interface LearningPathSources {
  surfaceState?: unknown;
  progressViews?: readonly LearningPathProgressView[];
}

export function buildLearningPathFromSources(
  sources: LearningPathSources,
  iconResolver?: (iconName?: string) => PathNodeView['icon'],
): LearningPathScreenModel {
  const focus = Array.isArray(sources.progressViews)
    ? sources.progressViews.find((view) => Array.isArray(view?.steps) && view.steps.length > 0)
    : undefined;
  if (focus) {
    const feed = projectProgressToPath(focus);
    if (feed.nodes.length > 0) {
      return buildLearningPathScreenModel(feed, iconResolver);
    }
  }
  return buildLearningPathScreenModel(sources.surfaceState, iconResolver);
}
