// packages/group/show/board-setting-info.ts
//
// DATA catalog: plain-language help for the non-obvious board-default settings, keyed by
// the SAME `BoardDefaultControlDescriptor.key` used in BOARD_DEFAULT_CONTROLS (item-appearance).
// The blind SettingInfoOverlay renders whichever entry matches a control's key — so an (i) help
// icon appears ONLY next to settings a plain label can't fully explain (L115/L118: no filler icons
// on self-evident controls like "New note width"). Adding help for a setting = one DATA row here,
// ZERO code change in the overlay/control/picker (L069/L090). A caller may still override with its
// own descriptors; this is the default catalog.

import type { SettingInfoDescriptor } from './SettingInfoOverlay.tsx';

export const BOARD_SETTING_INFO: Readonly<Record<string, SettingInfoDescriptor>> = {
  containerVariant: {
    key: 'containerVariant',
    title: 'Note style',
    description:
      'The default look for notes on this board — outlined, solid card, or subtle. Any single note can still be given its own style; this only sets the starting point.',
  },
  marker: {
    key: 'marker',
    title: 'Bullet marker',
    description:
      'Gives every note a leading glyph (•, ✓, ★) — handy for turning a board into a list or checklist. A note can still set or clear its own marker.',
  },
  shape: {
    key: 'shape',
    title: 'Note shape',
    description:
      'Defaults every note to a shape — ellipse, diamond, hexagon, and more — useful for diagrams and flowcharts. A note’s own shape always wins; "Default" returns to a rectangle.',
  },
  connectorStrokeStyle: {
    key: 'connectorStrokeStyle',
    title: 'Line style',
    description:
      'The brushstroke for connector lines: solid, dashed, dotted, or a hand-drawn pencil / marker / sketch look. Individual lines can still override this.',
  },
  borderStrokeStyle: {
    key: 'borderStrokeStyle',
    title: 'Note border style',
    description:
      'The outline texture for notes — solid, dashed, dotted, or a hand-drawn look. Applies to this board’s notes by default; a note can override its own border.',
  },
  connectorJumps: {
    key: 'connectorJumps',
    title: 'Line jumps at crossings',
    description:
      'When two connector lines cross, draw a small hop over the crossing so it’s clear the lines are not joined.',
  },
  connectorCorners: {
    key: 'connectorCorners',
    title: 'Corner style',
    description:
      'How connector lines turn corners — sharp angles or rounded bends.',
  },
  showPalette: {
    key: 'showPalette',
    title: 'Image colour palette',
    description:
      'Shows a strip of each image’s main colours beneath it — useful for mood boards and design boards. Off by default.',
  },
  photoFilter: {
    key: 'photoFilter',
    title: 'Image filter',
    description:
      'Applies a default filter (e.g. grayscale, sepia, high-contrast) to images placed on this board. A single image can still be filtered on its own.',
  },
  fontFamily: {
    key: 'fontFamily',
    title: 'Note font',
    description:
      'The default typeface for note text on this board, including a handwritten style. A note can still choose its own font.',
  },
  contentAnchor: {
    key: 'contentAnchor',
    title: 'Text placement',
    description:
      'Where text sits inside a note — top, centered, or bottom. Sets the board default; a note can place its own text differently.',
  },
  elevation: {
    key: 'elevation',
    title: 'Card depth',
    description:
      'How much shadow notes cast — flat, subtle, or lifted — giving the board more or less visual depth.',
  },
};
