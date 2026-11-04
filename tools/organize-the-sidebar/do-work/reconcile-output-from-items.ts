// packages/group/do-work/reconcile-output-from-items.ts
//
// Build a ProducerOutput for the AUTHORITATIVE-reconcile effect (a board-AI action
// whose record declares `effect: "reconcile"` — the agent returns the COMPLETE
// desired board, not just new cards). This is the third sibling of the two layout
// leaves (L069):
//   - layoutDraftsToOutput   → GENERATIVE: all-new items laid out in a grid (ADD)
//   - identityPatchOutput    → ENRICHMENT: patch ONE awaited member in place
//   - reconcileOutputFromItems → RECONCILE: the returned set IS the board
//
// The rule that makes "reorganize + edit the existing notes" work instead of
// "wipe and re-add": an item that ECHOES an existing `memberId` merges IN PLACE
// (its text/fields update, its geometry is left untouched so the card keeps its
// position — applyProducerOutput treats an omitted x/y as "keep current"). An item
// with NO memberId is a NEW note: it gets a minted id and a grid slot around the
// origin. Feeding this output to reconcileBoardGraphAuthoritative then removes any
// existing member the agent did NOT return — so the returned set is authoritative.
//
// Pure (ids injected, no Date/crypto) → deterministic + unit-testable, exactly like
// its two siblings. BLIND (L090): it never reads a domain field; `kind`/`text`/`src`
// and any `extra` are written verbatim into the opaque presentation.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { AddressRef } from '../../ui/show/group/group-graph';
import type { ProducerItem, ProducerOutput } from '../read-data/producer-output';
import type { ProducerDraft } from './layout-producer-drafts';

/** A reconcile item: a {@link ProducerDraft} that MAY carry an existing `memberId`.
 *  With a memberId → edit that member in place. Without → a new note to lay out. */
export interface ReconcileItem extends ProducerDraft {
  /** Echoed existing member to edit in place; absent → a new note. */
  readonly memberId?: string;
}

/** The shape a producer result item arrives in (as parsed by read-producer-status's
 *  `itemsFromResult`): kind/text/src/contentType/extra + an optional echoed memberId. */
export interface ProducerResultItemLike {
  readonly kind?: string;
  readonly text?: string;
  readonly src?: string;
  readonly contentType?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly memberId?: string;
}

/** Map a producer's result items to {@link ReconcileItem}s — the SSOT translation the
 *  board's consume seam uses (so the seam and its tests share ONE mapping). `kind`
 *  defaults to 'note' (the board's default card); every other field is carried
 *  verbatim, and an echoed `memberId` becomes the edit-in-place key. Blind (L090):
 *  it names no domain field. */
export function producerItemsToReconcileItems(
  items: readonly ProducerResultItemLike[],
): ReconcileItem[] {
  return items.map((it) => ({
    kind: it.kind ?? 'note',
    ...(it.text !== undefined ? { text: it.text } : {}),
    ...(it.src !== undefined ? { src: it.src } : {}),
    ...(it.contentType !== undefined ? { contentType: it.contentType } : {}),
    ...(it.extra ? { extra: it.extra } : {}),
    ...(typeof it.memberId === 'string' ? { memberId: it.memberId } : {}),
  }));
}

/**
 * Build the reconcile {@link ProducerOutput}. Existing items (memberId echoed) merge
 * in place with NO geometry (position preserved); new items (no memberId) are minted
 * and laid out in a grid around `origin`. The grid index counts ONLY new items, so
 * edits don't leave gaps in the placement of the genuinely-new cards.
 */
export function reconcileOutputFromItems(
  items: readonly ReconcileItem[],
  targetGroupRef: AddressRef,
  origin: { readonly x: number; readonly y: number },
  makeMemberId: () => string,
  makeNodeRef: () => AddressRef,
  existingIds?: ReadonlySet<string>,
): ProducerOutput {
  // An item edits IN PLACE only when it echoes a memberId that REALLY exists on the
  // board. A memberId the agent HALLUCINATED (echoed an id that is not on the board —
  // a real failure mode of an id-echo instruction) is treated as a genuinely NEW note:
  // minted + grid-placed, never a phantom "edit" that applyProducerOutput would create
  // as an UNPLACED card at (0,0). When `existingIds` is omitted, any memberId edits in
  // place (back-compat — callers that can't supply the board's ids keep the old shape).
  const editsInPlace = (it: ReconcileItem): boolean =>
    typeof it.memberId === 'string'
    && it.memberId.length > 0
    && (existingIds === undefined || existingIds.has(it.memberId));
  const newCount = items.filter((it) => !editsInPlace(it)).length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, newCount))));
  let newIndex = 0;
  const out: ProducerItem[] = items.map((it) => {
    const presentation: Record<string, unknown> = { kind: it.kind };
    if (it.text !== undefined) presentation.text = it.text;
    if (it.src !== undefined) presentation.src = it.src;
    if (it.contentType !== undefined) presentation.contentType = it.contentType;
    if (it.extra) Object.assign(presentation, it.extra);
    if (editsInPlace(it)) {
      // EDIT in place — no x/y, so applyProducerOutput keeps the card where it is.
      return { memberId: it.memberId as string, nodeRef: makeNodeRef(), presentation };
    }
    // NEW note (genuinely new, OR a hallucinated id not on the board) — mint an id and
    // place it in the next grid slot around the origin so it is never left unplaced.
    const index = newIndex++;
    presentation.x = Math.round(origin.x - 110 + (index % cols) * 240);
    presentation.y = Math.round(origin.y - 80 + Math.floor(index / cols) * 180);
    return { memberId: makeMemberId(), nodeRef: makeNodeRef(), presentation };
  });
  return { targetGroupRef, items: out };
}
