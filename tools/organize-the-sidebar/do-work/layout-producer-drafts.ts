// packages/group/do-work/layout-producer-drafts.ts
//
// Lay N producer drafts out in a grid around an origin → a ProducerOutput the board
// materializes via applyProducerOutput. Shared by BOTH multi-item paths so they place
// identically (L063 — one layout, not one per producer): the LOCAL paste/text-source
// fill and the REMOTE source-pull producer result. Pure: ids are injected (no Date /
// crypto here), so it is deterministic + unit-testable; the caller supplies id-gens.

import type { AddressRef } from '../../ui/show/group/group-graph';
import type { ProducerItem, ProducerOutput } from '../read-data/producer-output.ts';
import type { ProducerResultItem } from '../read-data/read-producer-status.ts';

/** A produced item's content, before layout. The board writes these fields verbatim
 *  into the item's opaque presentation (L090 — no kind branch). */
export interface ProducerDraft {
  readonly kind: string;
  readonly text?: string;
  readonly src?: string;
  readonly contentType?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export function layoutDraftsToOutput(
  drafts: readonly ProducerDraft[],
  targetGroupRef: AddressRef,
  origin: { readonly x: number; readonly y: number },
  makeMemberId: () => string,
  makeNodeRef: () => AddressRef,
): ProducerOutput {
  const cols = Math.max(1, Math.ceil(Math.sqrt(drafts.length)));
  const items: ProducerItem[] = drafts.map((draft, index) => {
    const presentation: Record<string, unknown> = {
      kind: draft.kind,
      x: Math.round(origin.x - 110 + (index % cols) * 240),
      y: Math.round(origin.y - 80 + Math.floor(index / cols) * 180),
    };
    if (draft.text !== undefined) presentation.text = draft.text;
    if (draft.src !== undefined) presentation.src = draft.src;
    if (draft.contentType !== undefined) presentation.contentType = draft.contentType;
    if (draft.extra) Object.assign(presentation, draft.extra);
    return { memberId: makeMemberId(), nodeRef: makeNodeRef(), presentation };
  });
  return { targetGroupRef, items };
}

/** The IDENTITY-PRESERVING sibling of {@link layoutDraftsToOutput} (L069). A producer
 *  that ENRICHES existing members (an OG fetch flipping a link card's title, a
 *  re-transcribe, a refresh) returns result items each naming an existing `memberId`
 *  plus a `presentation` patch. This builds the {@link ProducerOutput} that
 *  applyProducerOutput merges IN PLACE by identity — NO grid layout, NO minted member
 *  ids, NO trigger removal. Contrast layoutDraftsToOutput, which lays out NEW members.
 *
 *  `awaitedMemberId` is the card the board is polling for: its patch always folds in
 *  `status: 'done'` so the poller stops watching it, even if the producer's payload
 *  omitted it (fail-closed — never left waiting forever). If the producer never returned that
 *  member, a bare `{status:'done'}` patch is appended so the awaited card still settles.
 *
 *  Pure: `makeNodeRef` is injected (a merge ignores nodeRef; it matters only if the
 *  patched id happens not to exist yet, in which case applyProducerOutput INSERTs). */
export function identityPatchOutput(
  items: readonly { readonly memberId?: string; readonly presentation?: Readonly<Record<string, unknown>> }[],
  targetGroupRef: AddressRef,
  awaitedMemberId: string,
  makeNodeRef: () => AddressRef,
): ProducerOutput {
  const out: ProducerItem[] = [];
  let sawAwaited = false;
  for (const it of items) {
    if (!it.memberId || !it.presentation) continue;
    const isAwaited = it.memberId === awaitedMemberId;
    if (isAwaited) sawAwaited = true;
    out.push({
      memberId: it.memberId,
      nodeRef: makeNodeRef(),
      // The awaited card always settles (status:'done') so the poller releases it.
      presentation: isAwaited ? { ...it.presentation, status: 'done' } : { ...it.presentation },
    });
  }
  if (!sawAwaited) out.push({ memberId: awaitedMemberId, nodeRef: makeNodeRef(), presentation: { status: 'done' } });
  return { targetGroupRef, items: out };
}

/** True iff a producer result is IDENTITY-PRESERVING (at least one item names an
 *  existing member to patch) rather than GENERATIVE (all-new items to lay out). The
 *  poller uses this ONE predicate to pick the merge-in-place path vs the grid path. */
export function isIdentityPreserving(items: readonly { readonly memberId?: string }[]): boolean {
  return items.some((it) => typeof it.memberId === 'string' && it.memberId.length > 0);
}

/** Mixed results must not discard new cards just because another item names an
 * existing card. Compose the existing identity and layout owners once each. */
export function layoutMixedProducerOutput(
  items: readonly ProducerResultItem[], targetGroupRef: AddressRef,
  awaitedMemberId: string, origin: { readonly x: number; readonly y: number },
  makeMemberId: () => string, makeNodeRef: () => AddressRef,
): ProducerOutput {
  const identities = items.filter(item => Boolean(item.memberId)).map(item => ({
    memberId: item.memberId,
    presentation: {
      ...(item.kind !== undefined ? { kind: item.kind } : {}),
      ...(item.text !== undefined ? { text: item.text } : {}),
      ...(item.src !== undefined ? { src: item.src } : {}),
      ...(item.contentType !== undefined ? { contentType: item.contentType } : {}),
      ...item.extra,
      ...item.presentation,
    },
  }));
  const drafts = items.filter(item => !item.memberId).map(item => ({
    kind: item.kind ?? 'note', text: item.text, src: item.src,
    contentType: item.contentType, extra: item.extra,
  }));
  const patched = identityPatchOutput(identities, targetGroupRef, awaitedMemberId, makeNodeRef);
  const generated = layoutDraftsToOutput(drafts, targetGroupRef, origin, makeMemberId, makeNodeRef);
  return { targetGroupRef, items: [...patched.items, ...generated.items] };
}
