// packages/group/show/appearance-preset-catalog.ts
//
// #225 P1 (R2 "presets") — the BUILT-IN appearance presets: Society DATA in the
// feature package (same catalog pattern as board-backgrounds.ts / #155 shapes).
// A preset is a named bag of appearance-cascade keys; applying one to a board
// writes those keys onto the board's `appearance` (the middle cascade tier) so
// every note without its own override adopts the look. Adding a preset is ONE
// row below — zero new code, because `applyAppearancePresetToBoard` folds the
// bag through the generic `setBoardAppearanceKey` (blind to what the keys mean).
//
// These are STARTER looks the user can apply with one click. User-captured
// presets (save-this-board's-look) layer on top once a per-index preset store
// exists; the apply mechanism is identical (presetKeyWrites → setBoardAppearanceKey).

import type { AppearancePreset } from './appearance-presets.ts';
import type { AppearanceProfile } from './item-appearance.ts';
import { mergeCatalog } from '../read-data/catalog-merge.ts';

/** The built-in named looks. Each `profile` key is an appearance-cascade key
 *  (`sizeMode`, `containerVariant`, …) — this catalog never has to enumerate
 *  WHICH keys are legal; a new key added to the cascade is usable here as DATA. */
export const BUILT_IN_APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  {
    id: 'classic',
    name: 'Classic',
    // The pre-cascade default look (glassmorph surface, text grows to fit, cozy padding).
    profile: { containerVariant: 'surface', sizeMode: 'fit', padding: 'md' },
  },
  {
    id: 'focus',
    name: 'Focus',
    // Quiet ghost cards with a fixed, scrollable box + compact padding — dense boards stay tidy.
    profile: { containerVariant: 'ghost', sizeMode: 'scroll', padding: 'sm' },
  },
  {
    id: 'gallery',
    name: 'Gallery',
    // Raised cards that fill their box, tight padding — image/mood boards read as a grid of tiles.
    profile: { containerVariant: 'elevated', sizeMode: 'fill', padding: 'sm' },
  },
  {
    id: 'panel',
    name: 'Panel',
    // Solid panels, fit height, spacious padding — a document/outline feel.
    profile: { containerVariant: 'panel', sizeMode: 'fit', padding: 'lg' },
  },
  // These looks theme the board's CONNECTORS too (connectorRouting/arrow/dashed) — pure DATA that
  // fell out for free once those keys joined the cascade (the apply path never enumerates keys).
  {
    id: 'flowchart',
    name: 'Flowchart',
    // Crisp Card nodes wired by right-angle arrows — process/decision diagrams.
    profile: { containerVariant: 'elevated', sizeMode: 'fit', padding: 'md', connectorRouting: 'elbow', connectorArrow: 'end' },
  },
  {
    id: 'mindmap',
    name: 'Mind map',
    // Soft glass nodes joined by flowing curves with no arrowheads — associative maps.
    profile: { containerVariant: 'surface', sizeMode: 'fit', padding: 'md', connectorRouting: 'curved', connectorArrow: 'none' },
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    // Plain nodes and dashed straight guide-lines — sketchy wireframe / draft feel.
    profile: { containerVariant: 'ghost', sizeMode: 'fit', padding: 'sm', connectorRouting: 'straight', connectorDashed: true },
  },
  {
    id: 'bubble-map',
    name: 'Bubble map',
    // Oval "thought bubble" nodes joined by flowing curves — the classic idea/association map.
    // This preset ALSO defaults the node SHAPE (`shape: 'ellipse'`) — pure DATA that fell out for
    // free the moment `shape` joined the cascade (the apply path never enumerates keys), exactly as
    // the connector-style keys did. Proof that a new cascade key is instantly presettable (L069).
    profile: { containerVariant: 'surface', sizeMode: 'fit', padding: 'md', shape: 'ellipse', connectorRouting: 'curved', connectorArrow: 'none' },
  },
  {
    id: 'sketch',
    name: 'Sketch',
    // cont.26 (E4) — the hand-drawn WHITEBOARD look (Excalidraw/tldraw canon): a PENCIL connector
    // brushstroke (`connectorStrokeStyle:'pencil'` — the named Line-style axis, resolving to
    // roughness+bowing+dash) + a pencil note border (`borderRoughness`) + a HANDWRITTEN note font
    // (`fontFamily`), joined by plain straight lines. Pure DATA — it fell out for FREE the moment
    // those axes joined the cascade (the apply path never enumerates keys), exactly like `shape` did.
    // The L069 emergence proof for cont.26: a new cascade key is instantly a one-click theme, zero code.
    profile: {
      containerVariant: 'surface',
      sizeMode: 'fit',
      padding: 'md',
      connectorStrokeStyle: 'pencil',
      borderStrokeStyle: 'pencil',
      connectorRouting: 'straight',
      connectorArrow: 'none',
      fontFamily: "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', 'Patrick Hand', cursive",
    },
  },
] as const;

/** Look up a built-in preset by id (undefined → not found). */
export function builtInPresetById(id: string | undefined): AppearancePreset | undefined {
  if (!id) return undefined;
  return BUILT_IN_APPEARANCE_PRESETS.find((p) => p.id === id);
}

/** The published-record payload kind carrying user-defined appearance presets (Society DATA). */
export const APPEARANCE_PRESET_CATALOG_KIND = 'appearance-preset-catalog';

/** Validate one untrusted preset DATA row. id/name required; `profile` is an OPAQUE bag of
 *  appearance-cascade keys (this catalog never enumerates which keys are legal — a new cascade
 *  key is usable as DATA). A missing/non-object profile → an empty (no-op) preset. */
function presetFromData(row: Record<string, unknown>): AppearancePreset | null {
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null;
  const profile = (row.profile && typeof row.profile === 'object' ? row.profile : {}) as AppearanceProfile;
  return { id: row.id, name: row.name, profile };
}

/**
 * The EFFECTIVE appearance-preset catalog = the built-in looks + user-defined presets from
 * `appearance-preset-catalog` published-records (Society DATA), via the generic
 * {@link mergeCatalog} primitive (same as markers/backgrounds). A DATA row overrides a built-in
 * by id, else appends — so "which board looks exist" is DATA, not a source const.
 */
export function readAppearancePresetCatalog(
  records: ReadonlyArray<{ payload?: unknown }>,
): AppearancePreset[] {
  return mergeCatalog(records, {
    kind: APPEARANCE_PRESET_CATALOG_KIND,
    arrayKey: 'presets',
    idOf: (p) => p.id,
    parseRow: presetFromData,
    builtins: BUILT_IN_APPEARANCE_PRESETS,
  });
}
