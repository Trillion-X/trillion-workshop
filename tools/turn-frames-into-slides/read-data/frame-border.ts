// tools/turn-frames-into-slides/read-data/frame-border.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE canonical reader for a board item's frame border DATA
// (`extra.visualLayerStack.frame.border`). Before this, TWO layers parsed that
// field with TWO incompatible schemas — a silent SSOT divergence:
//
//   • the live card render (item-renderers `frameCardProps`) read it as a BOOLEAN
//     show/hide toggle (#90): `border === false → borderless`.
//   • the SVG export (board-svg `exportFillOf`) read it as an OBJECT `{color,width}`
//     stroke.
//
// So a `border:{color,width}` set in DATA rendered as the DEFAULT border on screen
// but a CUSTOM stroke in the export — screen and export disagreed, and a single
// value could not be both `false` and `{…}`. This module is the single source of
// truth: every reader normalizes through `readFrameBorder`, so the two surfaces can
// never drift again (L063 structural elimination + SSOT). It is a pure leaf — no
// React, no DOM — so both `show/` and `do-work/` import it without coupling.
//
// The normalized shape is a superset that expresses every case a border can be in:
//   • hidden           → { show: false }
//   • default chrome    → { show: true }                       (absent / `true`)
//   • custom stroke     → { show: true, color?, width? }       (object form)
//   • explicit hide+data→ { show: false, color?, width? }      (future: `{show:false,…}`)
//
// A legacy boolean is tolerated forever (existing #90 live DATA carries it), so this
// is additive, never a migration.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================
//
// -----------------------------------------------------------------------------
// SSOT RE-EXPORT (#200)
// -----------------------------------------------------------------------------
// The IMPLEMENTATION of `readFrameBorder` now lives ONCE, at the bedrock package
// that OWNS the frame schema — `@/packages/ui/show/visual-layer-stack/frame-border`,
// beside the `FrameDef` type and the `FrameControl` that WRITES the border (L088
// recursive-CSSOT placement). Keeping a second copy here would be exactly the SSOT
// divergence this module was created to KILL — two bodies drifting apart. So this
// file is now a thin re-export: it preserves the group-local import path
// (`@/packages/group/do-work/frame-border`) and the WHY-context above, while the
// single function body lives upstream.
//
// The re-export targets the PURE LEAF module path (not the `@/packages/ui`
// mega-barrel) so the React-free `board-svg` serializer stays React-free.
// -----------------------------------------------------------------------------

export { readFrameBorder } from './visual-layer-frame-border.ts';
export type { FrameBorder } from './visual-layer-frame-border.ts';
