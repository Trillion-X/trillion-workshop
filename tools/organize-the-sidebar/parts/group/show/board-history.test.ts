import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { pushBoardHistory, popBoardHistory } from '../../../show/board-history.ts';

describe('pushBoardHistory', () => {
  it('pushes the board being left', () => {
    expect(pushBoardHistory([], 'a', 'b')).toEqual(['a']);
    expect(pushBoardHistory(['a'], 'b', 'c')).toEqual(['a', 'b']);
  });

  it('is a no-op when there is no from board', () => {
    expect(pushBoardHistory(['a'], undefined, 'b')).toEqual(['a']);
  });

  it('is a no-op when from equals to (switch to the same board)', () => {
    expect(pushBoardHistory(['a'], 'b', 'b')).toEqual(['a']);
  });

  it('never mutates the input stack', () => {
    const s = ['a'] as const;
    pushBoardHistory(s, 'b', 'c');
    expect(s).toEqual(['a']);
  });
});

describe('popBoardHistory', () => {
  const active = new Set(['a', 'b', 'c']);

  it('pops the most-recent active board and returns the rest', () => {
    expect(popBoardHistory(['a', 'b'], active, 'c')).toEqual({ target: 'b', rest: ['a'] });
  });

  it('skips archived/deleted boards no longer active', () => {
    // "gone" is not in active → skipped; lands on "a"
    expect(popBoardHistory(['a', 'gone'], active, 'c')).toEqual({ target: 'a', rest: [] });
  });

  it('skips an entry equal to the current board', () => {
    expect(popBoardHistory(['a', 'c'], active, 'c')).toEqual({ target: 'a', rest: [] });
  });

  it('returns no target when the stack is empty', () => {
    expect(popBoardHistory([], active, 'c')).toEqual({ rest: [] });
  });

  it('returns no target when every entry is dead or current', () => {
    expect(popBoardHistory(['gone', 'c'], active, 'c')).toEqual({ rest: [] });
  });

  it('never mutates the input stack', () => {
    const s = ['a', 'b'];
    popBoardHistory(s, active, 'c');
    expect(s).toEqual(['a', 'b']);
  });
});
