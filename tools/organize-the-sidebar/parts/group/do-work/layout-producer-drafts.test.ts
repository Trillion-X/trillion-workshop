// Coverage for the shared grid-layout of producer drafts → ProducerOutput. Both the
// local multi-draft fill and the remote multi-item producer result use THIS, so they
// place identically. Pure (ids injected) → deterministic positions are assertable.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { identityPatchOutput, isIdentityPreserving, layoutDraftsToOutput, layoutMixedProducerOutput } from '../../../do-work/layout-producer-drafts.ts';

const ref = (id: string) => ({ partition: 'p', label: id }) as never;

describe('layoutMixedProducerOutput', () => {
  it('preserves an identity patch, top-level content and new text/image cards together', () => {
    let id = 0;
    const result = layoutMixedProducerOutput([
      { memberId: 'existing', text: 'Updated', presentation: { color: 'blue' } },
      { text: 'New note' }, { src: 'data:image/png;base64,AA==', kind: 'image' },
    ], ref('board'), 'existing', { x: 500, y: 300 }, () => `new-${++id}`, () => ref('node'));
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ memberId: 'existing', presentation: { text: 'Updated', color: 'blue', status: 'done' } });
    expect(result.items[0].presentation).not.toHaveProperty('x');
    expect(result.items[1]).toMatchObject({ memberId: 'new-1', presentation: { text: 'New note', x: 390, y: 220 } });
    expect(result.items[2]).toMatchObject({ memberId: 'new-2', presentation: { kind: 'image', src: 'data:image/png;base64,AA==' } });
  });

  it('settles an omitted initiating card without losing generated output', () => {
    const result = layoutMixedProducerOutput([
      { memberId: 'other', presentation: { text: 'Enriched' } }, { text: 'Generated' },
    ], ref('board'), 'trigger', { x: 0, y: 0 }, () => 'new', () => ref('node'));
    expect(result.items.map(item => item.memberId)).toEqual(['other', 'trigger', 'new']);
    expect(result.items[1].presentation).toEqual({ status: 'done' });
    expect(result.items[2].presentation.text).toBe('Generated');
  });
});

describe('layoutDraftsToOutput — shared producer-draft grid layout', () => {
  it('writes each draft field verbatim into the opaque presentation (L090, no kind branch)', () => {
    let n = 0;
    const out = layoutDraftsToOutput(
      [{ kind: 'note', text: 'Define' }, { kind: 'image', src: 'data:x', contentType: 'image/png' }],
      ref('group'),
      { x: 200, y: 100 },
      () => `m${n++}`,
      () => ref('node'),
    );
    expect(out.targetGroupRef).toMatchObject({ label: 'group' });
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ memberId: 'm0', presentation: { kind: 'note', text: 'Define' } });
    expect(out.items[1].presentation).toMatchObject({ kind: 'image', src: 'data:x', contentType: 'image/png' });
  });

  it('lays drafts in a sqrt-derived grid around the origin', () => {
    const out = layoutDraftsToOutput(
      Array.from({ length: 4 }, (_, i) => ({ kind: 'note', text: `n${i}` })),
      ref('group'),
      { x: 1000, y: 500 },
      () => 'm',
      () => ref('node'),
    );
    // 4 items → cols = ceil(sqrt(4)) = 2 → a 2x2 grid.
    expect(out.items[0].presentation).toMatchObject({ x: 890, y: 420 }); // col0,row0
    expect(out.items[1].presentation).toMatchObject({ x: 1130, y: 420 }); // col1,row0
    expect(out.items[2].presentation).toMatchObject({ x: 890, y: 600 }); // col0,row1
    expect(out.items[3].presentation).toMatchObject({ x: 1130, y: 600 }); // col1,row1
  });

  it('merges extra over the base presentation', () => {
    const out = layoutDraftsToOutput(
      [{ kind: 'note', text: 'k', extra: { tone: 'warm' } }],
      ref('group'),
      { x: 0, y: 0 },
      () => 'm',
      () => ref('node'),
    );
    expect(out.items[0].presentation).toMatchObject({ kind: 'note', text: 'k', tone: 'warm' });
  });
});

describe('isIdentityPreserving — the poller path discriminator', () => {
  it('is TRUE when any result item names an existing member (enrichment)', () => {
    expect(isIdentityPreserving([{ memberId: 'card-1', presentation: {} } as never])).toBe(true);
    expect(isIdentityPreserving([{ text: 'new' }, { memberId: 'card-2' }] as never)).toBe(true);
  });
  it('is FALSE for a purely generative result (all-new items, no memberId)', () => {
    expect(isIdentityPreserving([{ text: 'a' }, { src: 'x' }] as never)).toBe(false);
    expect(isIdentityPreserving([{ memberId: '' } as never])).toBe(false); // empty id ≠ identity
    expect(isIdentityPreserving([])).toBe(false);
  });
});

describe('identityPatchOutput — enrichment merge-in-place (no layout, no new ids)', () => {
  it('preserves each memberId and writes its presentation patch verbatim', () => {
    let n = 0;
    const out = identityPatchOutput(
      [{ memberId: 'card-1', presentation: { linkPreview: { title: 'Notion', image: 'https://x/i.png' } } }],
      ref('board'),
      'card-1',
      () => ref(`node${n++}`),
    );
    expect(out.targetGroupRef).toMatchObject({ label: 'board' });
    expect(out.items).toHaveLength(1);
    // The awaited card keeps its id, gets the linkPreview patch, and SETTLES (status:done).
    expect(out.items[0]).toMatchObject({
      memberId: 'card-1',
      presentation: { linkPreview: { title: 'Notion', image: 'https://x/i.png' }, status: 'done' },
    });
    // No grid coordinates minted — a patch never repositions the card (merge, not insert).
    expect(out.items[0].presentation).not.toHaveProperty('x');
  });

  it('folds status:done ONLY onto the awaited card, leaving sibling patches untouched', () => {
    const out = identityPatchOutput(
      [
        { memberId: 'card-1', presentation: { linkPreview: { title: 'A' } } },
        { memberId: 'card-2', presentation: { linkPreview: { title: 'B' } } },
      ],
      ref('board'),
      'card-1',
      () => ref('node'),
    );
    expect(out.items[0].presentation).toMatchObject({ linkPreview: { title: 'A' }, status: 'done' });
    expect(out.items[1].presentation).toEqual({ linkPreview: { title: 'B' } }); // sibling: no status
  });

  it('drops items missing a memberId or a presentation (nothing to patch)', () => {
    const out = identityPatchOutput(
      [{ presentation: { linkPreview: { title: 'orphan' } } }, { memberId: 'card-9' }, { memberId: 'card-1', presentation: { linkPreview: { title: 'ok' } } }],
      ref('board'),
      'card-1',
      () => ref('node'),
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ memberId: 'card-1' });
  });

  it('appends a bare status:done patch when the producer never returned the awaited card (fail-closed, never left waiting forever)', () => {
    const out = identityPatchOutput(
      [{ memberId: 'other', presentation: { linkPreview: { title: 'X' } } }],
      ref('board'),
      'awaited-card',
      () => ref('node'),
    );
    const awaited = out.items.find((i) => i.memberId === 'awaited-card');
    expect(awaited?.presentation).toEqual({ status: 'done' });
  });
});
