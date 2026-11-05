// Coverage for the MULTI-item discriminator of the producer status read — the seam
// that lets a remote agent/source producer return MANY board items (vs the image
// producer's single artifact). The board's consume effect materializes these via
// applyProducerOutput. itemsFromResult validates + normalizes the result's `items`.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { itemsFromResult } from '../../../read-data/read-producer-status.ts';

describe('itemsFromResult — multi-item producer result discriminator', () => {
  it('normalizes a list of note items from a breakdown producer', () => {
    const items = itemsFromResult([
      { kind: 'note', text: 'Define: launch academy' },
      { kind: 'note', text: 'Plan: launch academy' },
    ]);
    expect(items).toHaveLength(2);
    expect(items?.[0]).toMatchObject({ kind: 'note', text: 'Define: launch academy' });
  });

  it('keeps items with a src (an image/source pull) and carries extra', () => {
    const items = itemsFromResult([{ src: 'data:image/png;base64,AAA', contentType: 'image/png', extra: { tag: 'x' } }]);
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ src: 'data:image/png;base64,AAA', contentType: 'image/png', extra: { tag: 'x' } });
  });

  it('drops entries with neither text nor src NOR memberId (a producer can not emit empty items)', () => {
    expect(itemsFromResult([{ kind: 'note' }, { text: 'keep' }])).toHaveLength(1);
  });

  it('KEEPS an IDENTITY-PRESERVING patch item (memberId + presentation, no text/src) and carries its fields', () => {
    // Enrichment result: the OG fetch landed → patch the existing link card in place.
    const items = itemsFromResult([
      { memberId: 'card-7', presentation: { linkPreview: { title: 'Notion', image: 'https://x/i.png' } } },
    ]);
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      memberId: 'card-7',
      presentation: { linkPreview: { title: 'Notion', image: 'https://x/i.png' } },
    });
    expect(items?.[0].text).toBeUndefined();
    expect(items?.[0].src).toBeUndefined();
  });

  it('reads an optional nodeRef string on a result item (INSERT case; ignored on a merge)', () => {
    const items = itemsFromResult([{ memberId: 'card-1', nodeRef: 'item::b::1', presentation: { status: 'done' } }]);
    expect(items?.[0]).toMatchObject({ memberId: 'card-1', nodeRef: 'item::b::1' });
  });

  it('returns undefined for a non-array / empty / all-empty result (→ falls through to src/error/pending)', () => {
    expect(itemsFromResult(undefined)).toBeUndefined();
    expect(itemsFromResult([])).toBeUndefined();
    expect(itemsFromResult('nope')).toBeUndefined();
    expect(itemsFromResult([{ kind: 'note' }])).toBeUndefined();
  });

  it('red-team (cont.98 batch-37): caps a runaway producer result so the board never materializes unbounded members', () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => ({ kind: 'note', text: `n${i}` }));
    const items = itemsFromResult(huge);
    expect(items!.length).toBeLessThanOrEqual(1000);
    // a normal small result is unaffected (zero regression)
    expect(itemsFromResult([{ text: 'a' }, { text: 'b' }])).toHaveLength(2);
  });
});
