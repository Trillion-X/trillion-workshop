// The Group owner's addressed-surface commit boundary. The shared intent package
// validates transport/routing; this leaf validates the live catalog again, maps the
// payload through Group's existing draft translator, and acknowledges only after
// the Group graph write succeeds.

import type { AddressRef, GroupGraph } from '../../ui/show/group/group-graph';
import {
  surfaceIntentMatchesCatalogPayload,
  type PlaceableSurfacePayload,
} from '../../ui/show/placeable-surface-intent';
import { deliveryPlacementMemberId, graphContainsDeliveryPlacement } from '../read-data/delivery-placement';
import { itemRef, placeItem } from '../read-data/group-board-model';
import { boardDefaultItemSize } from './item-appearance';
import type { BoardItemDraft } from './item-add-strategies';
import { placeableSurfaceDraft } from './placeable-surface-shelf';

export type AddressedPlaceableSurfaceDisposition =
  | 'catalog-denied'
  | 'malformed-payload'
  | 'already-placed'
  | 'placed'
  | 'persistence-failed';

export interface AddressedPlaceableSurfaceResult {
  readonly accepted: boolean;
  readonly disposition: AddressedPlaceableSurfaceDisposition;
}

export interface CommitAddressedPlaceableSurfaceInput {
  readonly payload: PlaceableSurfacePayload;
  /** The current viewer-filtered catalog. A revoked row must deny before a write. */
  readonly catalog: readonly PlaceableSurfacePayload[];
  readonly deliveryRef?: string;
  readonly graph: GroupGraph;
  readonly parentRef: AddressRef;
  readonly boardId: string;
  readonly appearance: unknown;
  /** The recipient chooses its viewport center; this owner derives the draft's top-left. */
  readonly centerX: number;
  readonly centerY: number;
  /** Used only for the non-addressed reader rail, whose generic protocol has no delivery key. */
  readonly newId: (prefix: string) => string;
  /** GroupBoardPanel supplies its optimistic persistence transaction. */
  readonly persist: (after: GroupGraph, before: GroupGraph) => Promise<string | null>;
}

/** The durable Group graph-write primitive beneath a payload-specific translator. */
export interface CommitAddressedBoardDraftInput extends Omit<CommitAddressedPlaceableSurfaceInput, 'payload' | 'catalog'> {
  readonly draft: BoardItemDraft;
}

/**
 * Place exactly one catalog-authorized surface. A matching delivery marker already
 * in any graph group is an accepted durable no-op; a failed persistence attempt is
 * explicitly unacknowledged so the generic reader may retry from the source.
 */
export async function commitAddressedPlaceableSurface(
  input: CommitAddressedPlaceableSurfaceInput,
): Promise<AddressedPlaceableSurfaceResult> {
  if (!surfaceIntentMatchesCatalogPayload(input.payload, input.catalog)) {
    return { accepted: false, disposition: 'catalog-denied' };
  }

  const draft = placeableSurfaceDraft(input.payload);
  if (!draft) return { accepted: false, disposition: 'malformed-payload' };

  return commitAddressedBoardDraft({ ...input, draft });
}

/**
 * The one acknowledged Group graph mutation. It preserves the full board-draft
 * contract (`text`, `src`, content type, and opaque mount data) rather than
 * re-projecting a special surface-only card shape.
 */
export async function commitAddressedBoardDraft(
  input: CommitAddressedBoardDraftInput,
): Promise<AddressedPlaceableSurfaceResult> {
  const { draft } = input;

  if (input.deliveryRef && graphContainsDeliveryPlacement(input.graph, input.deliveryRef)) {
    return { accepted: true, disposition: 'already-placed' };
  }

  const memberId = input.deliveryRef ? deliveryPlacementMemberId(input.deliveryRef) : input.newId('m');
  const nodeItemId = input.deliveryRef ? memberId : input.newId('item');
  const defaultSize = boardDefaultItemSize(input.appearance as Parameters<typeof boardDefaultItemSize>[0]);
  const width = typeof draft.w === 'number' ? draft.w : defaultSize.w;
  const height = typeof draft.h === 'number' ? draft.h : defaultSize.h;
  const after = placeItem(input.graph, input.parentRef, {
    memberId,
    nodeRef: itemRef(input.boardId, nodeItemId),
    kind: draft.kind,
    x: Math.round(input.centerX - width / 2),
    y: Math.round(input.centerY - height / 2),
    w: width,
    h: height,
    text: draft.text,
    src: draft.src,
    extra: { ...(draft.extra ?? {}), ...(draft.contentType ? { contentType: draft.contentType } : {}) },
  });

  try {
    const failure = await input.persist(after, input.graph);
    return failure === null
      ? { accepted: true, disposition: 'placed' }
      : { accepted: false, disposition: 'persistence-failed' };
  } catch {
    return { accepted: false, disposition: 'persistence-failed' };
  }
}
