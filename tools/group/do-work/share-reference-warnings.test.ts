import { describe, expect, it } from 'vitest';
import { shareReferenceWarnings } from 'trillion-workshop/tools/organize-the-sidebar/do-work/share-reference-warnings.ts';
import type { ShareCapsule } from '../read-data/share-capsule';

const card = (memberId: string, text: string) => ({ memberId, text, kind: 'note', x: 0, y: 0, w: 100, h: 100 });
const capsule = (items: ReturnType<typeof card>[]): ShareCapsule => ({
  v: 1, id: 'test', name: 'Selected cards', boards: [{ boardId: 'a', title: 'Board A', items }],
});

describe('shareReferenceWarnings', () => {
  it('returns no warning for resolved links', () => {
    expect(shareReferenceWarnings(capsule([card('a', 'Source\n[[Target]]'), card('b', 'Target')]))).toEqual([]);
  });

  it('reports missing links without changing the shared snapshot', () => {
    const value = capsule([card('a', 'Source\n[[Private target]] [[private target]]')]);
    const before = JSON.stringify(value);
    expect(shareReferenceWarnings(value)).toEqual(['Board A / Source → [[Private target]]']);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('keeps resolution local to each board', () => {
    const value = capsule([card('a', 'Source\n[[Target]]')]);
    const withOtherBoard = { ...value, boards: [...value.boards, { boardId: 'b', title: 'Board B', items: [card('b', 'Target')] }] };
    expect(shareReferenceWarnings(withOtherBoard)).toEqual(['Board A / Source → [[Target]]']);
  });
});
