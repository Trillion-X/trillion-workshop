// packages/screen-arrangement/read-data/tab-presentation-modes.ts
//
// The tab presentation modes as DATA (B3) — replaces the closed `'tile' |
// 'canvas'` union. A mode is a self-describing `{ id, label }` row; the menu
// derives its options (label + Lucide icon) by mapping this registry (adding a mode = ONE data row,
// zero menu-code change), and `presentationMode` becomes an OPEN string the
// renderer dispatches on by capability (a known mode renders its way, unknown
// falls back to the default — L090, no switch over a closed set).
//
// This is the SSOT for tab modes: both the node-action menu and the node-menu
// controller import the type + registry from here (the prior `TabPresentationMode`
// import from layout-types referenced a type that was never defined there — a
// latent broken import esbuild silently stripped).

/** Open mode key — Society data, NOT a closed union. */
export type TabPresentationMode = string;

/** A self-describing tab presentation mode. */
export interface TabPresentationModeDescriptor {
  readonly id: TabPresentationMode;
  readonly label: string;
  /** Lucide icon name shown on the mode's menu row. */
  readonly icon: string;
}

/** The built-in modes. Owner/data may extend this; the menu + renderer stay blind. */
export const TAB_PRESENTATION_MODES: readonly TabPresentationModeDescriptor[] = [
  { id: 'tile', label: 'Tile', icon: 'LayoutGrid' },
  { id: 'canvas', label: 'Canvas', icon: 'Frame' },
];

/** The mode a tab falls back to when none is set or the set mode has no renderer. */
export const DEFAULT_TAB_PRESENTATION_MODE: TabPresentationMode = 'tile';
