// packages/group/show/mount-group-board.test.tsx
//
// readMountProps: an embedded board node's surfaceInput (PlaceableSurfaceHost
// props path) must override top-level props, mirroring live-feed-board's
// readBoardConfig — otherwise every embedded group-board falls back to 'board'.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { readMountProps } from '../../../show/mount-group-board.tsx';

describe('readMountProps', () => {
  it('merges surfaceInput over top-level props', () => {
    const out = readMountProps({ boardId: 'top', surfaceInput: { boardId: 'system-flow' } });
    expect(out.boardId).toBe('system-flow');
  });

  it('keeps top-level props when surfaceInput is absent', () => {
    expect(readMountProps({ board_id: 'agenda' }).board_id).toBe('agenda');
  });

  it('ignores non-object surfaceInput (array/string)', () => {
    expect(readMountProps({ boardId: 'top', surfaceInput: ['x'] }).boardId).toBe('top');
    expect(readMountProps({ boardId: 'top', surfaceInput: 'x' }).boardId).toBe('top');
  });

  it('preserves floating_frame and other host props alongside the merge', () => {
    const out = readMountProps({ floating_frame: { x: 1 }, surfaceInput: { boardId: 'b2' } });
    expect(out.floating_frame).toEqual({ x: 1 });
    expect(out.boardId).toBe('b2');
  });
});
