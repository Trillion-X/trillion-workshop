// packages/group/do-work/link-enrich-roundtrip.test.ts
//
// END-TO-END proof of the link-card enrichment CONSUMER chain — the exact sequence
// the GroupBoardPanel poller runs when an `action:enrich-link-preview` result lands,
// minus only the network read (transport is covered by read-producer-status tests):
//
//   raw enrich-result JSON  (what the def's write_result step persists)
//     → itemsFromResult      (the poller's producer-result discriminator)
//     → isIdentityPreserving (picks the merge-in-place path, not the grid path)
//     → identityPatchOutput  (builds the ProducerOutput, folds status:'done')
//     → applyProducerOutput  (merges by memberId onto the EXISTING pasted card)
//
// This de-risks the live proof: it proves the pasted link card is patched IN PLACE
// (title flips, og:image appears) while keeping its kind/position/src — the whole
// point of the #208 identity-preserving consumer — with zero engine.

import { describe, expect, it } from 'vitest';
import { emptyGraph, memberById, type AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { applyProducerOutput, applyPartialProducerOutput } from './apply-producer-output';
import { identityPatchOutput, isIdentityPreserving, layoutMixedProducerOutput } from './layout-producer-drafts';
import { itemsFromResult, itemResultStatus } from '../read-data/read-producer-status';

const board: AddressRef = { family: 'group', parts: { board: 'vision-board' } };
const itemRef = (id: string): AddressRef => ({ family: 'group', parts: { board: 'vision-board', item: id } });

/** A board holding one freshly-pasted, not-yet-enriched link card (kind:'link',
 *  the href in `src`, awaiting its OG result) — what linkCardDraft + placeDraftAt yield. */
function boardWithLinkCard(href: string): ReturnType<typeof emptyGraph> {
  return applyProducerOutput(emptyGraph(), {
    targetGroupRef: board,
    items: [{ memberId: 'card-1', nodeRef: itemRef('card-1'), presentation: { kind: 'link', x: 300, y: 200, src: href, status: 'pending' } }],
  });
}

describe('link-enrich consumer round-trip (raw result → patched card in place)', () => {
  it('keeps mixed successful output and the initiating error when another raw item is invalid', () => {
    const before = boardWithLinkCard('https://example.test');
    const status = itemResultStatus([
      { memberId: 'card-1', presentation: { linkPreview: { title: 'Useful title' } } },
      { text: 'Useful new note' }, null,
    ])!;
    expect(status.incomplete).toBe(true);
    const output = layoutMixedProducerOutput(status.items, board, 'card-1', { x: 300, y: 200 },
      () => 'new-note', () => itemRef('new-node'));
    const after = applyPartialProducerOutput(before, output, 'card-1');
    expect(memberById(after, board, 'card-1')?.presentation).toMatchObject({
      kind: 'link', x: 300, y: 200, src: 'https://example.test',
      linkPreview: { title: 'Useful title' }, status: 'error',
    });
    expect(memberById(after, board, 'new-note')?.presentation).toMatchObject({ text: 'Useful new note', kind: 'note' });
  });
  it('flips a pasted link card to the fetched title + og:image WITHOUT minting a new card or moving it', () => {
    const href = 'https://github.com/torvalds/linux';
    const graph = boardWithLinkCard(href);

    // The exact JSON the enrich def's parse_preview → write_result persists.
    const rawResult = {
      items: [
        {
          memberId: 'card-1',
          presentation: { linkPreview: { title: 'GitHub - torvalds/linux', image: 'https://github.githubassets.com/social.png' } },
        },
      ],
      preview: { title: 'GitHub - torvalds/linux', image: 'https://github.githubassets.com/social.png' },
    };

    // Poller step 1: discriminate the producer result.
    const items = itemsFromResult(rawResult.items);
    expect(items).toBeDefined();
    // Poller step 2: identity-preserving → merge-in-place branch (not the grid path).
    expect(isIdentityPreserving(items!)).toBe(true);
    // Poller step 3+4: build the identity patch and merge it by memberId.
    const output = identityPatchOutput(items!, board, 'card-1', () => itemRef('n1'));
    const next = applyProducerOutput(graph, output);

    const card = memberById(next, board, 'card-1');
    // The SAME card, patched: title/image enriched, kind + position + href preserved,
    // and it settled (status:'done') so the poller releases it.
    expect(card?.presentation).toMatchObject({
      kind: 'link',
      x: 300,
      y: 200,
      src: href,
      status: 'done',
      linkPreview: { title: 'GitHub - torvalds/linux', image: 'https://github.githubassets.com/social.png' },
    });
    // Exactly one card — no phantom minted member from the enrichment (a patch of an
    // EXISTING member never inserts; the injected nodeRef 'n1' is unused).
    expect(memberById(next, board, 'n1') ?? null).toBeNull();
  });

  it('empty extraction (no OG, no title) writes NO fake preview and still settles the card (L117)', () => {
    const graph = boardWithLinkCard('https://no-meta.example');
    // The def emits items:[] when nothing is extractable (parser → no preview).
    const items = itemsFromResult([]);
    // itemsFromResult returns undefined for an empty list → the poller treats it as
    // "no identity items"; the awaited card is settled by identityPatchOutput's
    // fail-closed bare patch so it never spins forever.
    expect(items).toBeUndefined();
    const settle = identityPatchOutput([], board, 'card-1', () => itemRef('n1'));
    const next = applyProducerOutput(graph, settle);
    const card = memberById(next, board, 'card-1');
    expect(card?.presentation).toMatchObject({ kind: 'link', src: 'https://no-meta.example', status: 'done' });
    expect(card?.presentation).not.toHaveProperty('linkPreview'); // no fake title
  });

  it('a partial extraction (title only, no image) enriches only what was found', () => {
    const graph = boardWithLinkCard('https://title-only.example');
    const items = itemsFromResult([{ memberId: 'card-1', presentation: { linkPreview: { title: 'Just A Title' } } }]);
    const output = identityPatchOutput(items!, board, 'card-1', () => itemRef('n1'));
    const card = memberById(applyProducerOutput(graph, output), board, 'card-1');
    expect(card?.presentation).toMatchObject({ kind: 'link', status: 'done', linkPreview: { title: 'Just A Title' } });
    expect((card?.presentation as { linkPreview?: { image?: string } }).linkPreview?.image).toBeUndefined();
  });
});
