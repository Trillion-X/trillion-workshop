// packages/screen-arrangement/show/node-action-pack.tsx
//
// The screen-arrangement's node actions — the Society DATA the generic
// NodeContextMenu (ui) renders. The menu/core name none of this; this pack
// declares each action, what node it accepts (by family/data, not a core
// switch), and what it does (closing over surface services). New actions = new
// entries here; zero core/menu change.
//
// Three behaviors per action, all blind to the menu:
//   • run     — a leaf command (tab-mode submenu options)
//   • submenu — nested choices (tab-mode)
//   • editor  — a rich panel hosted in the menu's glass popover. The panels are
//               generic ui/ primitives (RenamePanel, LayerStackPanel); this
//               pack only wires service-backed callbacks + the layer vocabulary.
//
// Decoration is the region's Visual Layer Stack, edited as a TREE: add/reorder/
// opacity/visibility/remove + per-layer settings (color wheel, grain amount).
// All writes go through surface services (slot-persisted via applyLayoutState).
// This pack owns the visual VOCABULARY (capabilityIds, z-order, labels); the
// surface owns the NodeRef→region mapping + commit (L098). The capability→label
// and capability→settings maps are DATA lookups, not switch(kind) (L090).

import React from 'react'
import type { NodeActionCapability, NodeActionPack, NodeRef } from '../../ui/show/node-actions';
import { later } from '../../ui/show/load-later/later';
// The editors open only when a person picks one from a node's menu, so they arrive then, not with the first paint.
const editors = () => import('../../ui/show/node-editors');
const RenamePanel = later(editors, module => module.RenamePanel);
const LayerStackPanel = later(editors, module => module.LayerStackPanel);
const BookmarksPanel = later(editors, module => module.BookmarksPanel);
import type { BookmarkRowInfo, LayerAddOption, LayerRowInfo } from '../../ui/show/node-editors';
import { builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack';
import type { AddressRef, VisualLayerDescriptor } from '../../ui/show/visual-layer-stack';
import { REGION_FAMILY } from '../read-data/region-address'
import { chooseLocalFiles } from '../../local-files/do-work/choose-local-files'
import { canonicalArtifactSubjectRef } from './visual-layer-runtime'
import { materializeBrowserBytes } from '../../ui/show/action-affordance/materialize-browser-artifact'
import {
  TAB_PRESENTATION_MODES,
  type TabPresentationMode,
} from '../read-data/tab-presentation-modes'

// Tab presentation mode is now an OPEN string sourced from TAB_PRESENTATION_MODES
// (B3) — the closed `'tile' | 'canvas'` union is dissolved. Kept as an alias so
// existing references read clearly.
export type TabPresentationModeValue = TabPresentationMode

// ---------------------------------------------------------------------------
// Visual vocabulary owned by this pack (screen-arrangement Society)
// ---------------------------------------------------------------------------
const REGISTRY: AddressRef = { family: 'visual-layer.capabilities', parts: {} }

// The capability pack is the SINGLE SOURCE OF TRUTH for what fills exist, how each
// presents (label/icon), how each is edited, and which are user-addable. This pack
// ADDS / DESCRIBES / EDITS layers by READING those declarations — it never
// switches on capabilityId and never hardcodes a fill list. Adding a fill (mesh,
// gradient editor, shape) = one registry entry, ZERO edits here (L063/L090).
const CAPS = builtinVisualLayerCapabilities
const DECORATION_MATERIALIZER = {
  target: 'content-media-evidence.materialize-artifact',
  admission: 'hosted-session-admitted' as const,
  output_contract: { kind: 'content-media.materialized-relation/v1' },
  relation: { role_ref: { id: 'visual-layer-subject' } },
}

/** Unique layer id so the stack can hold many layers of the same capability. */
function layerId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

/** Build a layer descriptor for ANY capability from its id + input + z. */
function makeLayer(capabilityId: string, input: Record<string, unknown>, z: number): VisualLayerDescriptor {
  return { id: layerId(capabilityId), order: { z }, paint: { capability: { registry: REGISTRY, capabilityId }, input } }
}

/** Row label + icon READ from the capability's own `presentation` declaration. */
function describeLayer(layer: VisualLayerDescriptor): LayerRowInfo {
  return CAPS[layer.paint.capability.capabilityId]?.presentation
    ?? { label: layer.paint.capability.capabilityId, icon: 'Square' }
}

/** Choose the capability that should paint a picked subject of `contentType`, by
 *  asking each capability's own `accepts()` predicate (the same matcher
 *  drop-to-layer uses). Falls back to the image capability. */
function subjectCapabilityFor(contentType: string): string {
  const probe = { id: 'probe', paint: { capability: { registry: REGISTRY, capabilityId: '' }, input: { contentType } } } as VisualLayerDescriptor
  for (const [id, cap] of Object.entries(CAPS)) {
    if (cap.accepts?.(probe)) return id
  }
  return 'image'
}

// ---------------------------------------------------------------------------
// Services — implemented by the surface (it owns the stores). The pack/menu
// stay blind to HOW a node is named or where its region lives (L098).
// ---------------------------------------------------------------------------
export interface NodeActionServices {
  setTabPresentationMode(tabId: string, mode: TabPresentationModeValue): void
  getTabPresentationMode(tabId: string): TabPresentationModeValue
  nodeName(nodeRef: NodeRef): string
  renameNode(nodeRef: NodeRef, name: string): void
  /** The node's decoration layer stack (excludes the content layer). */
  getNodeLayers(nodeRef: NodeRef): readonly VisualLayerDescriptor[]
  addNodeLayer(nodeRef: NodeRef, descriptor: VisualLayerDescriptor): void
  reorderNodeLayers(nodeRef: NodeRef, orderedIds: string[]): void
  patchNodeLayer(nodeRef: NodeRef, layerId: string, patch: { opacity?: number; enabled?: boolean; blend?: string }): void
  patchNodeLayerInput(nodeRef: NodeRef, layerId: string, inputPatch: Record<string, unknown>): void
  removeNodeLayer(nodeRef: NodeRef, layerId: string): void
  /** Save a bookmark pointing at this node (idempotent on the node id). */
  bookmarkNode(nodeRef: NodeRef): void
  /** All saved bookmarks as generic list rows (id + label + folder + icon). */
  listBookmarks(): BookmarkRowInfo[]
  /** Remove a bookmark by its id. */
  removeBookmark(bookmarkId: string): void
  /** Open (focus/activate) the node a bookmark points at. */
  openBookmark(bookmarkId: string): void
  /** Toggle this region's immersive override (hide ALL its chrome ↔ restore). */
  toggleRegionImmersive(nodeRef: NodeRef): void
  /** True when this region is currently immersive (its own chrome all hidden). */
  regionIsImmersive(nodeRef: NodeRef): boolean
}

function tabIdOf(nodeRef: NodeRef): string | null {
  return nodeRef.family === REGION_FAMILY.tab ? (nodeRef.parts.tabId ?? null) : null
}

// ---------------------------------------------------------------------------
// Per-layer settings editors — capabilityId → editor (DATA map, not a switch).
// Each returns ui components only; the LayerStackPanel renders them blind.
// ---------------------------------------------------------------------------
// Per-layer settings READ from the capability's own `editor` (storage-blind — the
// capability gets the current input + a patchInput wired to this surface's commit).
// No switch: a capability without an editor simply has no settings drawer.
function layerSettings(
  services: NodeActionServices,
  nodeRef: NodeRef,
  layer: VisualLayerDescriptor,
): React.ReactNode {
  const cap = CAPS[layer.paint.capability.capabilityId]
  if (!cap?.editor) return null
  return cap.editor({
    input: layer.paint.input,
    patchInput: (patch) => services.patchNodeLayerInput(nodeRef, layer.id, patch),
  })
}

// ===========================================================================
// Actions (DATA)
// ===========================================================================

function tabModeAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'tab-mode',
    label: 'Tab mode',
    icon: 'LayoutGrid',
    priority: 10,
    accepts: (nodeRef) => tabIdOf(nodeRef) !== null,
    submenu: (nodeRef) => {
      const tabId = tabIdOf(nodeRef)
      if (!tabId) return []
      const current = services.getTabPresentationMode(tabId)
      const option = (mode: TabPresentationModeValue, label: string, icon: string): NodeActionCapability => ({
        id: `tab-mode:${mode}:${tabId}`,
        label,
        icon: current === mode ? 'Check' : icon,
        accepts: () => true,
        run: () => services.setTabPresentationMode(tabId, mode),
      })
      return TAB_PRESENTATION_MODES.map((m) => option(m.id, m.label, m.icon))
    },
  }
}

// Immersive = "hide ALL of THIS region's chrome" (note #33). Two complementary
// capabilities whose `accepts` reads the region's current immersive state — the
// idiomatic dynamic-label form (no enum, no stateful label). Both toggle the same
// pure region-side-map write; the renderer drops the region's header/frame/padding.
function enterImmersiveAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'region-immersive-enter',
    label: 'Make immersive',
    icon: 'Expand',
    priority: 9,
    accepts: (nodeRef) => !services.regionIsImmersive(nodeRef),
    run: (nodeRef) => services.toggleRegionImmersive(nodeRef),
  }
}

function exitImmersiveAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'region-immersive-exit',
    label: 'Exit immersive',
    icon: 'Shrink',
    priority: 9,
    accepts: (nodeRef) => services.regionIsImmersive(nodeRef),
    run: (nodeRef) => services.toggleRegionImmersive(nodeRef),
  }
}

function renameAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'rename',
    label: 'Rename',
    icon: 'PencilLine',
    priority: 0,
    accepts: () => true,
    editor: (nodeRef, close) => (
      <RenamePanel
        value={services.nodeName(nodeRef)}
        onCommit={(name) => { services.renameNode(nodeRef, name); close() }}
        onCancel={close}
      />
    ),
  }
}

/** The layer tree — add/reorder/opacity/visibility/remove + per-layer settings. */
function layersAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'layers',
    label: 'Background & layers…',
    icon: 'Layers',
    priority: 20,
    accepts: () => true,
    editor: (nodeRef, close) => {
      // Add-menu rows are DERIVED from the capability registry (every capability
      // that declares an addAffordance) — no hardcoded list.
      const addOptions = addOptionsFromRegistry(services, nodeRef)
      return (
        <LayerStackPanel
          layers={services.getNodeLayers(nodeRef)}
          describeLayer={describeLayer}
          onReorder={(ids) => services.reorderNodeLayers(nodeRef, ids)}
          onSetOpacity={(id, opacity) => services.patchNodeLayer(nodeRef, id, { opacity })}
          onToggleVisible={(id, visible) => services.patchNodeLayer(nodeRef, id, { enabled: visible })}
          onRemove={(id) => services.removeNodeLayer(nodeRef, id)}
          addOptions={addOptions}
          renderLayerSettings={(layer) => layerSettings(services, nodeRef, layer)}
          emptyMessage="No layers yet. Add a color, gradient, image, or video."
          onDone={close}
        />
      )
    },
  }
}

// Add-layer choices DERIVED from the capability registry: every capability that
// declares an `addAffordance` becomes an Add-menu row, sorted by its order. A
// static-default capability adds with its `defaultInput`; a `requiresSubject`
// capability (image/video) runs the subject picker. Adding a fill = one registry
// entry, ZERO edits here.
function addOptionsFromRegistry(services: NodeActionServices, nodeRef: NodeRef): LayerAddOption[] {
  return Object.entries(CAPS)
    .filter(([, cap]) => cap.addAffordance)
    .sort(([, a], [, b]) => (a.addAffordance?.order ?? 999) - (b.addAffordance?.order ?? 999))
    .map(([capabilityId, cap]) => {
      const aff = cap.addAffordance!
      return {
        id: `add-${capabilityId}`,
        label: cap.presentation?.label ?? capabilityId,
        icon: cap.presentation?.icon ?? 'Square',
        run: aff.requiresSubject
          ? () => { void addSubjectLayer(services, nodeRef, aff.subjectPrefixes ?? [], aff.defaultZ ?? -1) }
          : () => services.addNodeLayer(nodeRef, makeLayer(capabilityId, aff.defaultInput ?? {}, aff.defaultZ ?? -1)),
      }
    })
}

// Pick a subject file, materialize it through the admitted content-media owner,
// and add a layer painted by
// whichever capability accepts that content type. Wrapped so a large-media
// failure SURFACES instead of vanishing (the F1 category fix: invisible async
// failure -> visible). Large media can fail two ways — the picker returns no
// bytes (whole-file base64 over the local-process stdout caps out), or
// materialization fails (the bounded browser-source contract rejects it).
async function addSubjectLayer(
  services: NodeActionServices,
  nodeRef: NodeRef,
  prefixes: readonly string[],
  z: number,
): Promise<void> {
  try {
    const files = await pickSubjectFiles(prefixes)
    const file = files[0]
    if (!file) {
      console.warn('[decoration-add] picker returned no usable file — bytes may be absent for large media (whole-file base64 transport cap)')
      return
    }
    const contentType = file.type || 'application/octet-stream'
    const bytes = new Uint8Array(await file.arrayBuffer())
    console.info(`[decoration-add] picked ${contentType} bytes=${bytes.byteLength}`)
    const materialized = await materializeBrowserBytes({
      bytes,
      media_type: contentType,
      display_name: file.name,
      descriptor: DECORATION_MATERIALIZER,
    })
    console.info(`[decoration-add] relation=${materialized.relation_ref}`)
    services.addNodeLayer(nodeRef, makeLayer(subjectCapabilityFor(contentType), {
      subject: canonicalArtifactSubjectRef(materialized.relation_ref),
      contentType,
      label: file.name,
      fit: 'cover',
    }, z))
  } catch (error) {
    console.error('[decoration-add] FAILED to add media layer', error)
  }
}

// The WebKit shell's browser file input does not reliably open Finder; the proven
// path is the native OS picker via compute.process. The accepted content-type
// prefixes come from the capability's addAffordance, so the picker filters to what
// it paints. We reuse it and build real File objects.
async function pickSubjectFiles(prefixes: readonly string[]): Promise<File[]> {
  const chosen = await chooseLocalFiles({
    prompt: 'Choose a file',
    multiple: false,
    includeBytes: true,
    allowedContentPrefixes: [...prefixes],
  })
  return chosen
    .filter((file) => file.bytes)
    .map((file) => new File([file.bytes as Uint8Array], file.name, { type: file.contentType }))
}

/** Save a bookmark pointing at this node. Idempotent — re-running updates it. */
function bookmarkAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'bookmark',
    label: 'Bookmark',
    icon: 'Bookmark',
    priority: 30,
    accepts: () => true,
    run: (nodeRef) => services.bookmarkNode(nodeRef),
  }
}

/** Open the bookmarks list (folder-grouped); click a row to jump to that node. */
function bookmarksAction(services: NodeActionServices): NodeActionCapability {
  return {
    id: 'bookmarks',
    label: 'Bookmarks…',
    icon: 'BookMarked',
    priority: 40,
    accepts: () => true,
    editor: (_nodeRef, close) => (
      <BookmarksPanel
        bookmarks={services.listBookmarks()}
        onOpen={(id) => {
          services.openBookmark(id)
          close()
        }}
        onRemove={(id) => services.removeBookmark(id)}
        onDone={close}
      />
    ),
  }
}

/** Build the screen-arrangement node-action pack. R11 adds history. */
export function buildNodeActionPack(services: NodeActionServices): NodeActionPack {
  return [
    renameAction(services),
    tabModeAction(services),
    enterImmersiveAction(services),
    exitImmersiveAction(services),
    layersAction(services),
    bookmarkAction(services),
    bookmarksAction(services),
  ]
}
