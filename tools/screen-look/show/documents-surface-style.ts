// Shared composition-editor appearance. Documents supplies scene data and uses this one Screen Look source.
export const DOCUMENTS_SURFACE_CSS = `
/* Drag pickup chrome (owner: "see it getting picked up and dragged"). While a block drags,
   the whole surface shows a grabbing cursor and a floating ghost chip follows the pointer
   (the dragged block itself is dimmed via opacity-40 on its frame). */
.ca-root[data-dragging] {
  cursor: grabbing;
}
.ca-root[data-dragging] * {
  cursor: grabbing !important;
}
.ca-drag-ghost {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--black-rich, #17171b);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.14));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  color: var(--text-primary, #f4f4f4);
  font-size: 12.5px;
  opacity: 0.92;
}

.ca-root {
  --stage-inset-left: 0px;
  --stage-inset-right: 0px;
  --stage-inset-top: 0px;
  --stage-inset-bottom: 0px;
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--text-primary, #f4f4f4);
  background: transparent;
  overflow: hidden;
  /* Shared popovers use the current Screen Look surface at every mount. */
  --glass-bg-strong: var(--glass-bg-popover, rgba(18, 18, 20, 0.96));
  /* The block-grip gutter (B-44c): the host reserves this much space to the LEFT of the
     content plane so every block's [+]/drag grip sits beside the block, never inside its
     box — for text AND containers alike. The flow content plane is inset by this and the
     engine viewport shrinks to match (no overflow). Narrows on phones where the grip is
     hover-only (touch has no hover) so it doesn't eat a touch layout. */
  --ca-gutter: 44px;
}

/* The .ca-rail rules are gone. Rail chrome, row anatomy, hover highlight and the
   active-row treatment now belong to the owned sidebar in packages/sidebar, so
   Documents no longer paints a second sidebar look that can drift from the real
   one. The Amie row anatomy the owner asked for (the ROW is the single hovered
   container, the label paints no second background, the actions reveal inside
   that container) is the owned sidebar's row behaviour, applied everywhere at
   once instead of only here. */

.ca-main {
  position: relative;
  margin-left: var(--stage-inset-left, 0px);
  margin-right: var(--stage-inset-right, 0px);
  margin-top: var(--stage-inset-top, 0px);
  margin-bottom: var(--stage-inset-bottom, 0px);
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ca-title {
  padding: 16px 22px 0;
}

.ca-stage {
  position: relative;
  flex: 1;
  margin: 14px 22px 22px;
  overflow: auto;
  /* The stage is programmatically focusable (tabIndex=-1: Cmd+A escalation moves
     focus here so the NEXT keydown still reaches the page — WKWebView drops the
     key first-responder on a bare blur). That focus is an implementation seam,
     not a user-facing selection: the browser's default focus ring drew a blue
     border around the ENTIRE page, reading as "everything is an input". The
     selection WASH on the chosen blocks is the visible state; the stage shows
     no chrome of its own. */
  outline: none;
  /* Reserve the scrollbar gutter ALWAYS so a vertical scrollbar appearing can't
     shrink clientWidth — that would change the measured viewport and re-fire the
     reflow ResizeObserver (Codex Q3). With the gutter stable, the engine viewport
     is a pure function of the stage's layout box, not its scroll state. */
  scrollbar-gutter: stable;
  background: transparent;
}

/* Canvas mode: the camera is the ONLY navigation (Codex free-pan Q2) — native
   scroll would fight the camera-pan, so hide it; grab cursor signals pannability. */
.ca-stage-canvas {
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  /* Infinite-canvas dot grid (Mobbin: ClickUp / Dovetail / Stitch / Figma all
     paint one). Longhands -- NOT the background shorthand -- so the inline
     world-anchored background-position (offset by -pan, set per-render on the
     stage) composes; the grid then scrolls WITH the engine-offset frames and
     reads as one continuous infinite plane rather than a fixed screen texture. */
  background-image: radial-gradient(circle, var(--canvas-grid-dot, rgba(255, 255, 255, 0.10)) 1.2px, transparent 1.4px);
  background-size: 24px 24px;
}
.ca-stage-canvas:active {
  cursor: grabbing;
}

/* Canvas HUD + minimap slots (B-46): screen-fixed chrome anchored to the stage's
   bottom corners. They are siblings of the transformed .ca-content-plane, so they
   never pan/zoom with the world. The stage clips them with overflow:hidden; in
   canvas mode the stage never scrolls, so bottom-anchored = always in view. */
.ca-canvas-hud-slot {
  position: absolute;
  left: 16px;
  bottom: 16px;
  z-index: 30;
}
.ca-canvas-minimap-slot {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 30;
}

/* The content plane (B-44c): the engine-coordinate origin, inset from the stage's
   left by the grip gutter in FLOW mode. width = 100% - gutter so the engine viewport
   (measured on THIS element via attachStage) shrinks to match and flow content never
   spills into the gutter. height:100% so the vertical viewport equals the stage. It is
   position:relative = the positioned ancestor for every abspos SceneFrame, so the grip
   (right: calc(100% + 2px)) lands in the gutter to its left. */
.ca-content-plane {
  position: relative;
  height: 100%;
  margin-left: var(--ca-gutter);
  width: calc(100% - var(--ca-gutter));
}
/* Canvas mode: gutter = 0 (identity wrapper) — free-positioned nodes pan on the
   infinite plane, no document gutter; the plane is a transparent passthrough. */
.ca-content-plane-canvas {
  margin-left: 0;
  width: 100%;
}

/* The per-block grip ([+] + drag handle), reveal-on-hover. Positioned in the LEFT
   GUTTER beside the block (Mobbin: Notion / Craft / Threads block grips live in a left
   gutter, never inside the block). right:calc(100% + 2px) puts its right edge 2px
   left of the frame, so it sits beside ANY node — text or container — with zero per-kind
   logic. The --ca-gutter reserves enough room that it never clips the stage. */
.ca-grip {
  position: absolute;
  right: calc(100% + 2px);
  top: 2px;
  z-index: 10;
}
/* A hovered composite must not reveal every descendant's controls. Each
   grip follows its immediate frame; generic ancestor group-hover is broader.
   The shared reveal item's utilities (group-hover/hover-reveal:opacity-100 and
   its focus forms) weigh two classes and are not in a layer, so this rule weighs
   three (:not(.ca-grip) matches every child) to win over them in any order; the
   two reveal rules below weigh as much or more and come after it. */
.ca-root .ca-grip > :not(.ca-grip) { opacity: 0; }
[class~="group/hover-reveal"]:hover > .ca-grip > *,
.ca-root:not(:has([class~="group/hover-reveal"]:hover > .ca-grip)) [class~="group/hover-reveal"]:focus-within > .ca-grip > * { opacity: 1; }
/* Nested frames share the writing gutter. The deepest hovered/focused frame
   owns its controls; pointer hover takes precedence over a different focused
   editor. Match direct grips without nesting :has (invalid CSS). */
[class~="group/hover-reveal"]:has([class~="group/hover-reveal"]:hover > .ca-grip) > .ca-grip,
.ca-root:not(:has([class~="group/hover-reveal"]:hover > .ca-grip)) [class~="group/hover-reveal"]:has([class~="group/hover-reveal"]:focus-within > .ca-grip) > .ca-grip {
  visibility: hidden;
}
/* Canvas page-cards (#38): a top-level node positioned on the canvas reads as a CARD
   (ClickUp / Fibery / Figma frames). SceneFrame is a BLIND positioner (zero visual
   styling by contract), so the card surface is host chrome here — scoped to canvas
   view AND to the framed root's DIRECT children (the pages), so document view and
   nested blocks are untouched. Pure CSS over the engine frame: the card surface IS
   the frame, so it tracks position under pan/zoom for free — no overlay, no coordinate
   math, no node-style pollution (which SceneFrame would ignore anyway). The
   .ca-content-plane segment is REQUIRED: B-44c nests the scene one level inside the
   plane (the camera-transform / grip-gutter origin), so the framed root is the plane's
   child, and the page-cards are its grandchildren. */
.ca-stage-canvas > .ca-content-plane > [data-node-id] > [data-node-id] {
  background: var(--black-rich, #141414);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

@media (max-width: 720px) {
  .ca-root {
    flex-direction: column;
    /* Keyboard focus and touch reveal the same actions as desktop hover. Keep
       their gutter so actions cannot clip or cover the writing. */
    --ca-gutter: 44px;
  }
  /* The phone rail rules are gone with the rest of the rail. Turning it into a
     scrolling horizontal strip was the best a CSS-only fallback could do. The
     owned sidebar ships a real mobile presentation with a focus trap, a scroll
     lock and a close control, so Documents no longer needs a phone rule here. */
}

.ca-node {
  position: absolute;
  box-sizing: border-box;
}

.ca-container-node {
  pointer-events: none;
}

.ca-text-node {
  display: block;
  pointer-events: auto;
  overflow: visible;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary, #f4f4f4);
  font: inherit;
  min-width: 160px;
  /* One line tall, not a hardcoded 34px slab. min-height = exactly one line-height so
     an EMPTY block stays clickable but a one-line block carries ZERO dead space below
     its text (the "why is there this much space below a block" defect). Extra space is
     the user's to add per block via margin (engine-honored DATA), never forced here. */
  line-height: 1.7;
  min-height: 1.7em;
  /* No left gutter padding here anymore: the grip gutter is now a UNIVERSAL host
     gutter (the content plane is inset, the grip sits in it for every node type), so
     text aligns with container content instead of carrying its own per-type inset (B-44c). */
  padding: 1px 0;
  caret-color: var(--text-primary, #f4f4f4);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ca-text-node a[data-inline-link] {
  color: var(--accent-primary, var(--accent-purple, #a78bfa));
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 60%, transparent);
  text-underline-offset: 2px;
  cursor: pointer;
}

/* Placeholder shows ONLY on the block you are actively editing while it is empty
   (Notion/Craft: the caret's block, not every empty block). :focus = the caret is
   in this contenteditable; [data-empty=true] = text-empty per the editor's own
   readBlockText, NOT the CSS :empty pseudo — a focused contentEditable keeps a stray
   br after you type+backspace, so :empty goes false and the hint vanishes forever.
   The surface stamps data-empty from readBlockText on focus/input, so the hint
   tracks real text-emptiness. A resting/unfocused empty block shows nothing. */
.ca-text-node:focus[data-empty="true"] {
  /* Anchor for the OUT-OF-FLOW hint below. relative with no offsets = zero layout change. */
  position: relative;
}
.ca-text-node:focus[data-empty="true"]::before {
  content: attr(data-placeholder);
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  pointer-events: none;
  /* The hint is overlay CHROME, so it lives OUT OF THE LAYOUT FLOW — this one property is
     the category fix for every hint-vs-content interaction: an in-flow ::before either
     wraps (spills over the block below) or, as display:block, TAKES the first line box and
     pushes the caret's empty line BELOW the hint (the "caret is on the line below the
     placeholder" defect). Absolutely positioned, the hint paints over the block's own
     first line while the caret owns that same line at offset 0 — hint and caret coexist,
     and the hint is invisible to layout (scrollHeight, engine frames, siblings) forever. */
  position: absolute;
  top: 1px; /* = the block's own vertical padding, so the hint sits exactly on the text line */
  left: 0;
  right: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ca-text-node:focus {
  outline: none;
}

.ca-component-node {
  display: grid;
  place-items: center;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 16px;
  background: var(--glass-bg-secondary, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.72));
}

.ca-edge-layer {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.36));
}

.ca-edge-layer path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

/* Connection MEANING pill (#37): an in-SVG label that is clickable (the layer is
   pointer-events:none, the pill opts back IN) to cycle the connection's kind. */
.ca-edge-label {
  pointer-events: auto;
  cursor: pointer;
}
.ca-edge-label-bg {
  fill: rgba(20, 20, 22, 0.92);
  stroke: rgba(255, 255, 255, 0.10);
  stroke-width: 1;
}
.ca-edge-label:hover .ca-edge-label-bg {
  fill: rgba(34, 34, 38, 0.96);
}
.ca-edge-label-text {
  font-size: var(--font-size-caption);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.ca-format-bar {
  position: relative;
  max-width: calc(100vw - 16px);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: color-mix(in srgb, var(--black-rich, #141414) 78%, transparent);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  /* When the bar is capped to a narrow viewport (max-width set in JS), the buttons
     scroll horizontally instead of overflowing — single-row scrollable format bar
     (Apple Notes / Universe mobile). Scrollbar hidden for the clean floating look. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ca-format-bar::-webkit-scrollbar { display: none; }
.ca-format-btn { flex: 0 0 auto; }

.ca-format-sep {
  width: 1px;
  align-self: stretch;
  margin: 3px;
  background: var(--border-primary, rgba(255, 255, 255, 0.10));
}

/* Swatch trigger indicator — a small round chip showing the active colour (or a
   rainbow conic-gradient when none is set = "pick a colour"). */
.ca-format-swatch-indicator {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}

/* Swatch popover — a sibling of the bar (escapes its overflow), glassmorphic like the
   bar, a wrapping grid of colour chips. */
.ca-format-swatches {
  position: relative;
  z-index: 7;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: min(296px, calc(100vw - 16px));
  padding: 10px;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: color-mix(in srgb, var(--black-rich, #141414) 82%, transparent);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
}
.ca-format-swatch { flex: 0 0 auto; }
.ca-format-swatch-chip {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}

.ca-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px 1px 4px;
  margin: 0 1px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent-blue, #4f8cff) 16%, transparent);
  color: var(--accent-blue, #4f8cff);
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  vertical-align: baseline;
  cursor: default;
  user-select: none;
}
.ca-ref-chip-ico { font-size: 0.85em; opacity: 0.8; }
.ca-ref-chip-label { color: inherit; }

/* Composer CONTENT layout only. The floating shell (portal, position, opaque surface,
   radius, shadow) is the shared AnchoredOverlay primitive — no package-local popover
   chrome (Package UI Reference Lock / no custom styling where a ui primitive owns it).
   The ACCENT WASH is layered over the overlay's opaque surface: the same translucent
   accent fill as block selection (SceneFrame's wash — user: the Ask-AI area should be
   that color, not plain black). Same color-mix recipe, same live token. */
.ca-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 320px;
  max-width: min(560px, 80vw);
  padding: 8px 10px;
  border-radius: var(--radius-lg, 12px);
  background: color-mix(in srgb, var(--accent-blue, #4c8dff) 17%, transparent);
}
.ca-composer-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 20px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary, #f2f2f5);
  font-size: 14px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Placeholder for the empty contentEditable composer (an input's ::placeholder doesn't apply). */
.ca-composer-input:empty::before {
  content: attr(data-placeholder);
  color: var(--text-ghost, rgba(255, 255, 255, 0.4));
  pointer-events: none;
}
/* The Ask-AI run control is the shared ui Button (variant=primary) — no bespoke button CSS. */
/* Menu/picker CONTENT: the floating shell (portal, fixed position, layer) is the shared
   AnchoredOverlay; this styles only the listbox surface itself. */
.ca-menu {
  display: flex;
  flex-direction: column;
  width: min(300px, 80vw);
  /* Bounded height (owner: "way too tall compared to notion") — the catalog scrolls inside
     instead of growing the popover. Notion caps near min(60vh). */
  max-height: min(58vh, 408px, var(--anchored-overlay-max-height, 100dvh));
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.14));
  border-radius: 14px;
  /* OPAQUE (owner: "the popover for the slash menu is still transparent") — a solid surface,
     no color-mix transparency, no backdrop blur to see through. */
  background: var(--bg-surface, #17171b);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--text-primary, #17171b) 18%, transparent);
  padding: 6px;
  overflow: hidden;
}

/* The scrolling catalog region. Footer (Close) lives OUTSIDE this and stays pinned. */
.ca-menu-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* Top/bottom opacity fade as you scroll (the owner referenced the record-audio/video review
     list) — the first/last rows dissolve into the chrome rather than a hard clipped edge. */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  scrollbar-width: thin;
}

.ca-menu-group + .ca-menu-group {
  margin-top: 2px;
}

.ca-menu-section {
  padding: 8px 10px 4px;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  font-size: var(--font-size-caption);
  font-weight: 600;
}

.ca-menu-row {
  display: flex;
  justify-content: flex-start;
  min-height: 32px;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary, #f4f4f4);
  padding: 7px 10px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
}

.ca-menu-row-main {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  text-align: left;
  font: inherit;
}

.ca-menu-row-configure {
  flex: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.58));
  padding: 3px 5px;
  font: inherit;
  font-size: var(--font-size-caption);
}

.ca-menu-row-configure[aria-selected="true"],
.ca-menu-row-configure:hover,
.ca-menu-row-configure:focus-visible {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.14));
  color: var(--text-primary, #f4f4f4);
}

.ca-menu-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.78));
  font-size: 12px;
  flex: none;
}

.ca-menu-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ca-menu [role="option"][aria-selected="true"],
.ca-menu-row-active,
.ca-menu-row:hover {
  background: color-mix(in srgb, var(--text-primary, #17171b) 8%, var(--bg-surface, #fff));
}

.ca-menu-row-active .ca-menu-ico,
.ca-menu-row:hover .ca-menu-ico {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.14));
  color: var(--text-primary, #f4f4f4);
}

/* Config disclosure panel content: human option rows (label + what it runs on +
   description) and the writing-instructions preamble (visible + editable). Same
   ca-menu shell as / and @ — these style only the row INTERNALS. */
.ca-config {
  width: min(400px, 86vw);
}
.ca-config-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.ca-config-option-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.ca-config-annotation {
  margin-left: auto;
  flex: none;
  color: var(--text-ghost, rgba(255, 255, 255, 0.4));
  font-size: var(--font-size-caption);
  font-weight: 500;
}
.ca-config-description {
  color: var(--text-dim, rgba(244, 244, 244, 0.55));
  font-size: 12px;
  font-weight: 400;
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ca-config-preamble {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-dim, rgba(244, 244, 244, 0.55));
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
}
.ca-config-preamble-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 10px 10px;
}
.ca-config-preamble-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.ca-menu-empty {
  padding: 12px;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.48));
  font-size: 13px;
}

.ca-menu-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  margin-top: 4px;
  padding: 7px 8px 4px 10px;
  border-top: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  font-size: var(--font-size-caption);
}

.ca-menu-hint {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Clickable Close affordance (owner: "they also have a fixed closed text button"). The
   shortcut label inside is sourced from the dismiss keymap row, never hardcoded twice. */
.ca-menu-close {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  border: 0;
  border-radius: 7px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.74));
  padding: 4px 8px;
  font: inherit;
  font-size: var(--font-size-caption);
  font-weight: 500;
  cursor: pointer;
}

.ca-menu-close:hover {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.13));
  color: var(--text-primary, #f4f4f4);
}

.ca-menu-foot kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  margin-right: 2px;
  border-radius: 4px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.08));
  font-family: inherit;
  font-size: var(--font-size-caption);
}

/* A collapsed panel's spine — a thin vertical rail filling the 36px engine frame.
   Fills via width/height:100% (frame-relative) rather than absolute inset so it
   stays confined to the frame regardless of the frame's positioning context. */
.ca-panel-spine {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.04));
  border-radius: 8px;
  overflow: hidden;
}
.ca-panel-spine-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: var(--black-rich, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, inherit);
  cursor: pointer;
}
.ca-panel-spine-expand:hover {
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.12));
}
.ca-panel-spine-title {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: var(--font-size-caption);
  line-height: 1;
  color: var(--text-ghost, rgba(255, 255, 255, 0.6));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: calc(100% - 40px);
  letter-spacing: 0.02em;
}
.ca-authored-checkbox, .ca-authored-disclosure {
  position: absolute;
  z-index: 2;
  left: -4px;
  top: 0;
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 4px;
  color: var(--text-secondary);
}
@media (pointer: coarse) {
  .ca-authored-checkbox, .ca-authored-disclosure { left: -20px; top: -8px; width: 44px; height: 44px; min-width: 44px; padding: 12px; }
}
`;
