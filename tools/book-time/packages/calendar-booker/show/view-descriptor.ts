// packages/calendar-booker/show/view-descriptor.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic, owner-translated view-descriptor model consumed by the blind
// `DescriptorSurface` renderer. Every screen the calendar-booker package shows
// (owner workbench, availability setup, public guest page, guest preview) is a
// tree of these descriptors. The descriptors are produced by the package feed
// (`do-work/scheduling-offer-feed.ts`) — the SOLE translation boundary (L098) —
// already carrying human labels, human status text, and an owner tone vocabulary.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO scheduling vocabulary. No field names like `booking`, `slot`,
//    `availability`, `host`, `invitee`, `duration`. These types describe SHAPE,
//    never a specific product domain — any package could emit them.
// 2. `render_kind` is an opaque, data-selected capability key. The renderer
//    never enumerates its values (L090); a leaf capability pack
//    (`render-capability-map.ts`) binds current-name keys → ui primitives.
// 3. `label`, `status.label`, `option.label`, `action.label`, `status.reason`
//    are ALREADY human and ALREADY translated by the feed. The renderer prints
//    them verbatim. No primitive-side humanization is permitted for this content.
// 4. `status.tone_ref` is an OPEN owner tone vocabulary (string), translated to
//    a ui tone by the leaf capability pack with a safe neutral fallback. The
//    renderer never hardcodes a color or a closed tone enum.
//
// =============================================================================

/**
 * A single option in a selectable control (e.g. a pill bar). `value` is the
 * stable, owner-defined identity; `label` is the human, already-translated text.
 */
export interface ViewOption {
  value: string;
  label: string;
  status?: StatusDescriptor;
}

/**
 * Owner-translated status. `label` and `reason` are printed verbatim. `tone_ref`
 * is an open owner tone vocabulary (e.g. `attention` | `positive` | `danger`),
 * mapped to a ui tone by the leaf capability pack.
 */
export interface StatusDescriptor {
  tone_ref: string;
  label: string;
  reason?: string;
}

/**
 * An owner action the surface can invoke. `action_ref` routes through
 * `slot::workflow` (`execute_definition`) — the renderer never names a target.
 * `label` is the human button text. A present `disabled_reason` disables the
 * control and supplies its (already human) explanation.
 */
export interface ActionDescriptor {
  action_ref: string;
  label: string;
  arg_schema_ref?: string;
  disabled_reason?: string;
}

/**
 * One node in a screen tree. The renderer dispatches solely on `render_kind`
 * through the capability map; every other field is generic payload the bound
 * primitive consumes.
 */
export interface ViewDescriptor {
  id: string;
  render_kind: string;
  label?: string;
  help?: string;
  value?: unknown;
  options?: ViewOption[];
  status?: StatusDescriptor;
  actions?: ActionDescriptor[];
  editable?: boolean;
  children?: ViewDescriptor[];
}
