// packages/group/show/BoardMarkLayers.done.test.tsx
//
// Owner-side mode closure for the drawing toolbar (R33). The board OWNS the
// active tool; DrawToolBinder re-derives session.enabled from it. So Done must
// reach the board's onDone (which switches the tool back), or the binder
// re-enables drawing and the toolbar never dismisses. This renders the REAL
// BoardMarkLayers tree and proves the toolbar's Done click arrives at the
// owner callback.

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { BoardMarkLayers, DrawToolBinder } from './BoardMarkLayers';
import { MarkSessionProvider } from '../../addressed-marks/show/MarkSessionContext';

vi.mock('../../addressed-marks/show/use-mark-data', () => ({
  useOptionalBitfieldData: () => [],
  useMarkOperations: () => [],
  useMarkStyles: () => [],
  useMarkTools: () => [],
}));

// No vitest globals in this repo: testing-library cannot auto-cleanup, so
// unmount between tests explicitly (matches stamp-tool.test.tsx).
afterEach(() => cleanup());

function Harness({ active, onDone }: { active: boolean; onDone: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  return (
    <MarkSessionProvider>
      <div ref={stageRef}>
        <DrawToolBinder active={active} />
        <BoardMarkLayers
          stageRef={stageRef}
          camera={{ panX: 0, panY: 0, zoom: 1 }}
          screenToWorld={(x, y) => ({ x, y })}
          boardId="board-1"
          onDone={onDone}
        />
      </div>
    </MarkSessionProvider>
  );
}

describe('BoardMarkLayers Done threading', () => {
  it('threads the toolbar Done click to the owner onDone', async () => {
    const onDone = vi.fn();
    const view = render(<Harness active={true} onDone={onDone} />);
    // DrawToolBinder enables the session from the active tool; the toolbar
    // then renders its Done button.
    const done = await view.findByText('Done');
    await act(async () => {
      fireEvent.click(done);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps the toolbar hidden while the draw tool is not active', () => {
    const view = render(<Harness active={false} onDone={vi.fn()} />);
    expect(view.queryByText('Done')).toBeNull();
  });
});
