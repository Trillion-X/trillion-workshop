// parts/screen-arrangement/show/region-drop-intents.ts
//
// The screen-arrangement's drop intents — the Society data the generic
// RegionDropRouter (ui) dispatches a dropped subject to. The router is blind to
// these; adding a new intent is one more entry here, zero router changes.
//
//   open-as-tab       — default; owns the whole region (drop anywhere = open).
//   present-immersive — containers only; opens or moves the surface chrome-free.
//   present-files     — containers only; admits an external computer file unless
//                       a child screen under the pointer owns file drops.
//   set-as-background — the stage only (the canvas or workspace backdrop that
//                       passes setBackground); a picture from the computer
//                       dropped there becomes the wallpaper.
//
// A surface dragged out of a screen (a file row, a hover preview) carries the
// placeable-surface payload into open-as-tab or present-immersive. A file
// dragged in from the computer belongs to a child screen that accepts files
// under the pointer (the Files drop area, the message box). On a container
// with no such owner it becomes one file-presentation tab. On the open stage it
// can become a background, but never while over a pane. The router asks again as
// the drag moves, so it never covers an owning screen or swallows its drop. Tab
// drops on tab rows and edges remain with the arranger; center drops move through
// the shared region router.

import { readVisualLayerDrop, canPaintDataTransfer, type DropIntentCapability, type RegionDrop } from '../../ui'
import { isOverSelectedRecordDropOwner } from '../../ui/show/selection'
import { readPlaceableSurfaceSubject } from '../../ui/show/placeable-surface-intent'
import { type AddressRef, type VisualLayerDescriptor } from '../../ui/show/visual-layer-stack'
import { hasPlaceableSurface } from './placeable-surface-drag'
import {
  canonicalArtifactSubjectRef,
  visualLayerCapabilityPack,
} from './visual-layer-runtime'
import { materializeBrowserBytes } from '../../ui/show/action-affordance/materialize-browser-artifact'

const TAB_REORDER_TYPE = 'application/x-tab-id'
const CONTAINER_REORDER_TYPE = 'application/x-container-id'
export const TAB_EDGE_DROP_PX = 48
/** The innermost pane under the pointer owns its drag, including across React roots. */
export function isPaneDragTarget(pane: HTMLElement, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return element?.closest('[data-arrangement-pane]') === pane
}
/** Every pane's host carries this; its box is pane content, never the stage. */
const PANE_SELECTOR = '[data-container-id]'
const FILE_DROP_OWNER_SELECTOR = '[data-accepts-external-files]'
const DECORATION_MATERIALIZER = {
  target: 'content-media-evidence.materialize-artifact',
  admission: 'hosted-session-admitted' as const,
  output_contract: { kind: 'content-media.materialized-relation/v1' },
  relation: { role_ref: { id: 'visual-layer-subject' } },
}

export interface RegionDropIntentArgs {
  /** The region the intents target (container / canvas / surface). */
  readonly region: AddressRef
  /** Host-specific open action (addSurfaceTab for a container, createContainerAt at the drop point for the canvas). */
  readonly openAsTab: (drop: RegionDrop) => boolean | void | Promise<boolean | void>
  /**
   * Append a wallpaper layer to this region's stack. Only a stage region (the
   * freeform canvas, the workspace backdrop) passes it; a pane never does.
   */
  readonly setBackground?: (descriptor: VisualLayerDescriptor) => void
  /**
   * Enter immersive chrome for this region (idempotent) — the present intent
   * uses it so a dropped media surface lands chrome-free (note #33). A region
   * with no immersive concept omits this, and the present zone never appears.
   */
  readonly setImmersive?: () => void
  /** Move an existing tab into this region. Tab identity stays owner-controlled. */
  readonly moveTab?: (tabId: string) => void
}

/** True only for the arrangement's own surface drag (never a computer file, never a tab reorder). */
export function isArrangementSurfaceDrag(dataTransfer: DataTransfer): boolean {
  if (Array.from(dataTransfer.types ?? []).includes(TAB_REORDER_TYPE)) return false
  if (Array.from(dataTransfer.types ?? []).includes(CONTAINER_REORDER_TYPE)) return false
  return hasPlaceableSurface(dataTransfer)
}

/** Existing tabs are a move operation, handled by the arrangement owner. */
export function isArrangementTabDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(TAB_REORDER_TYPE)
}

/** A tab or surface edge drop belongs to the arranger, which must stay visible above the region overlay. */
export function isArrangementEdgeDrop(dataTransfer: DataTransfer, target: EventTarget | null, clientX: number, clientY: number): boolean {
  if (isOverSelectedRecordDropOwner(dataTransfer, clientX, clientY)) return false
  if (!isArrangementTabDrag(dataTransfer) && !isArrangementSurfaceDrag(dataTransfer)) return false
  const element = target instanceof Element ? target : null
  const pane = element?.closest<HTMLElement>('[data-arrangement-pane]')
  if (!pane) return false
  const bounds = pane.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return false
  return clientX - bounds.left <= TAB_EDGE_DROP_PX
    || bounds.right - clientX <= TAB_EDGE_DROP_PX
    || clientY - bounds.top <= TAB_EDGE_DROP_PX
    || bounds.bottom - clientY <= TAB_EDGE_DROP_PX
}

/** A computer file is presentable only when it is not an internal structured drag. */
export function isExternalFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  return types.includes('Files') && !types.some((type) => type.startsWith('application/x-'))
}

/** File-aware child screens keep first refusal for drops inside their own bounds. */
export function isOverExternalFileDropOwner(clientX: number, clientY: number): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(FILE_DROP_OWNER_SELECTOR)).some((owner) => {
    const box = owner.getBoundingClientRect()
    return box.width > 0 && box.height > 0
      && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
  })
}

/** True when the point is on the stage: inside no pane's box (a pane's content belongs to its screen). */
export function isOverStage(clientX: number, clientY: number): boolean {
  return !Array.from(document.querySelectorAll<HTMLElement>(PANE_SELECTOR)).some((pane) => {
    const box = pane.getBoundingClientRect()
    return box.width > 0 && box.height > 0
      && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
  })
}

/**
 * Promote a dropped wallpaper layer through the picture-keeping owner (in
 * Trillion, src/workspace/backgrounds.ts keeps it in the person's files) and
 * persist only its relation identity. Browser object URLs are created by the
 * rendering boundary and revoked on unmount; they never become durable state.
 * A keeping failure rejects the intent before `setBackground` runs.
 */
async function durableBackgroundDescriptor(
  descriptor: VisualLayerDescriptor,
  subjectAddress: string,
): Promise<VisualLayerDescriptor> {
  const snapshot = readPlaceableSurfaceSubject(subjectAddress)
  const handle = snapshot?.handle
  if (!(handle instanceof Blob)) return descriptor
  const input = descriptor.paint.input
  const contentType = String(input.contentType ?? handle.type ?? 'application/octet-stream')
  const bytes = new Uint8Array(await handle.arrayBuffer())
  const materialized = await materializeBrowserBytes({
    bytes,
    media_type: contentType,
    display_name: String(input.label ?? snapshot?.display?.name ?? 'Background'),
    descriptor: DECORATION_MATERIALIZER,
  })
  return {
    ...descriptor,
    paint: {
      ...descriptor.paint,
      input: { ...input, subject: canonicalArtifactSubjectRef(materialized.relation_ref) },
    },
  }
}

/** Build this region's drop-intent pack (open/move, container presentation, external files, or stage background). */
export function buildRegionDropIntents(args: RegionDropIntentArgs): DropIntentCapability[] {
  const { openAsTab, setBackground, setImmersive, moveTab } = args
  const intents: DropIntentCapability[] = [
    {
      id: 'open-as-tab',
      label: 'Open here',
      priority: 0,
      isDefault: true,
      accepts: ({ dataTransfer, clientX, clientY }) => !isOverSelectedRecordDropOwner(dataTransfer, clientX, clientY)
        && (isArrangementSurfaceDrag(dataTransfer)
          || (Boolean(moveTab) && isArrangementTabDrag(dataTransfer))),
      apply: (drop) => {
        if (isOverSelectedRecordDropOwner(drop.dataTransfer, drop.clientX, drop.clientY)) return false
        if (isArrangementTabDrag(drop.dataTransfer)) {
          const tabId = drop.dataTransfer.getData(TAB_REORDER_TYPE)
          if (!tabId || !moveTab) return false
          moveTab(tabId)
          return true
        }
        return openAsTab(drop)
      },
    },
  ]
  // The background zone exists only for a stage region, and shows only while a
  // paintable picture is over the stage itself, never over a pane.
  if (setBackground) {
    intents.push({
      id: 'set-as-background',
      label: 'Set as background',
      icon: 'image',
      priority: 1,
      accepts: ({ dataTransfer, clientX, clientY }) =>
        canPaintDataTransfer(dataTransfer, visualLayerCapabilityPack) && isOverStage(clientX, clientY),
      apply: async ({ dataTransfer }) => {
        const drop = readVisualLayerDrop(dataTransfer, visualLayerCapabilityPack)
        if (!drop) return false
        // Persist only the kept picture's relation identity, so the background
        // survives reload after the transient handle dies.
        setBackground(await durableBackgroundDescriptor(drop.descriptor, drop.subjectAddress))
        return true
      },
    })
  }
  // The present zone exists only for regions that can go immersive (a container);
  // canvas/surface regions omit setImmersive, so the pack never carries a dead
  // intent. Adding it here keeps the router blind — it just sees one more zone.
  if (setImmersive) {
    intents.push({
      id: 'present-immersive',
      label: 'Hide tabs and fill pane',
      icon: 'expand',
      priority: 2,
      accepts: ({ dataTransfer, clientX, clientY }) => !isOverSelectedRecordDropOwner(dataTransfer, clientX, clientY)
        && (isArrangementSurfaceDrag(dataTransfer)
          || (Boolean(moveTab) && isArrangementTabDrag(dataTransfer))),
      apply: async (drop) => {
        if (isOverSelectedRecordDropOwner(drop.dataTransfer, drop.clientX, drop.clientY)) return false
        // Guard on the same droppability the zone's `accepts` uses.
        const tabId = isArrangementTabDrag(drop.dataTransfer)
          ? drop.dataTransfer.getData(TAB_REORDER_TYPE)
          : ''
        if (!isArrangementSurfaceDrag(drop.dataTransfer) && (!tabId || !moveTab)) return false
        // Order matters and is race-free: setImmersive synchronously commits the
        // region's immersive chrome into the owner state ref FIRST, so the queued
        // (async) addSurfaceTab op reads it as its `prev` and the engine reply
        // carries it forward via preserveClientOwnedFields. Opening first would let
        // addSurfaceTab's reply land last and clobber a later immersive write.
        setImmersive() // the region hides its chrome
        if (tabId) moveTab!(tabId)
        else await openAsTab(drop)
        return true
      },
    })
    intents.push({
      id: 'present-files',
      label: 'Present files here',
      icon: 'image',
      priority: 3,
      accepts: ({ dataTransfer, clientX, clientY }) => isExternalFileDrag(dataTransfer)
        && !isOverExternalFileDropOwner(clientX, clientY),
      apply: (drop) => openAsTab(drop),
    })
  }
  return intents
}
