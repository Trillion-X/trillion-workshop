// @vitest-environment jsdom

import React, { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@bitfield/runtime-kit/react', () => ({
  useBitfieldData: () => [],
}));
vi.mock('@/packages/ui/show/placeable-surface-intent', () => ({
  readPublishedRecords: () => [],
}));
vi.mock('@/packages/ui/show/action-affordance', () => ({
  readActionAffordances: () => [],
}));
vi.mock('@/packages/group/show/board-action-affordances', () => ({
  affordanceShelfTools: () => [],
}));
vi.mock('@/packages/activity-feed/show/ActivityIndicator', () => ({
  ActivityIndicator: () => null,
}));
vi.mock('@/packages/group/show/GroupBoardPanel', async () => {
  const { CanvasViewport } = await import('@/packages/ui/show/canvas-viewport/CanvasViewport');
  return {
    GroupBoardPanel: ({ title }: { title: string }) => (
      <CanvasViewport aria-label={`${title} canvas`}>
        <div />
      </CanvasViewport>
    ),
  };
});

import mount from './mount-vision-board';

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

describe('Vision Board mounted canvas accessibility', () => {
  it('mounts the exact named application region through the generic canvas contract', () => {
    const el = document.createElement('div');
    let dispose: (() => void) | void;
    act(() => {
      dispose = mount({ el });
    });

    const canvas = el.querySelector<HTMLElement>('[role="application"][aria-label="Vision Board canvas"]');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('tabindex')).toBe('0');

    act(() => {
      dispose?.();
    });
  });
});
