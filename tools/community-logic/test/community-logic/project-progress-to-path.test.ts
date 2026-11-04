// Vendored unchanged except for import paths from bitfield-packages/packages/learning-path/__tests__/project-progress-to-path.test.ts.
import { describe, it, expect } from '../../../match-community-members/test/vitest-shim.mjs';
import {
  projectProgressToPath,
  type LearningPathProgressView,
} from '../../src/community-logic/project-progress-to-path.ts';

const VIEW: LearningPathProgressView = {
  title: 'Decision mastery',
  steps: [
    { id: 's3', label: 'Review', sortOrder: 3, completed: false, current: false },
    { id: 's1', label: 'Frame', sortOrder: 1, completed: true, current: false },
    { id: 's2', label: 'Test', sortOrder: 2, completed: false, current: true },
  ],
};

describe('projectProgressToPath', () => {
  it('orders owner-ready steps and keeps caller-language labels', () => {
    const feed = projectProgressToPath(VIEW);
    expect(feed.title).toBe('Decision mastery');
    expect(feed.nodes.map((node) => node.id)).toEqual(['s1', 's2', 's3']);
  });

  it('maps completed/current booleans without reading owner storage fields', () => {
    expect(projectProgressToPath(VIEW).nodes.map((node) => node.status)).toEqual(['complete', 'active', 'locked']);
  });

  it('is total for missing and empty views', () => {
    expect(projectProgressToPath(null)).toEqual({ title: '', nodes: [] });
    expect(projectProgressToPath(undefined)).toEqual({ title: '', nodes: [] });
    expect(projectProgressToPath({ ...VIEW, steps: [] }).nodes).toEqual([]);
  });
});
