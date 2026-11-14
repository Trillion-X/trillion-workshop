// packages/ui/show/floating-panel-opener/floating-panel-opener.ts
//
// Purpose: the one seam through which any package unpins content into the
// shared floating (PiP) panel without importing the owner that draws it.
// The arrangement owner provides the opener when it mounts; a sidebar list,
// a control group, or anything else asks for a panel and puts its content in
// the returned body. No caller has its own floating implementation.
// Invariants: one opener at a time (the latest provider wins until it
// withdraws); when none is provided `openFloatingPanel` returns null and the
// caller keeps its content where it is. Every app that renders shared ui
// provides one (the arrangement owner, or the app entry through
// mountFloatingPanel), so a panel is always a movable, resizable window and
// never a blocking modal.

export interface FloatingPanelHandle {
  /** Where the caller renders its content. */
  readonly body: HTMLElement;
  readonly close: () => void;
}

export interface FloatingPanelRequest {
  readonly label: string;
  /** Remembers the person's size per kind. Defaults to the label. */
  readonly kind?: string;
  /** Shown as a heading at the top of the panel. */
  readonly title?: string;
  /** One line under the title. */
  readonly description?: string;
  /** Size before the person resizes it; the height follows the content. */
  readonly size?: { readonly w: number; readonly h: number };
  /** False for work panels: menus opened inside do not close it and several can be open. */
  readonly exclusive?: boolean;
  /** Adds a status and an alert line under the body; React callers bring their own. */
  readonly liveRegions?: boolean;
  /** Stacking layer from LAYER_ORDER; defaults to picture-in-picture. */
  readonly layer?: number;
  /** Called when the person closes the panel. */
  readonly onClose?: () => void;
  /** The close control's words and icon when closing puts the content back (an unpinned list pins back). */
  readonly closeAs?: { readonly label: string; readonly icon: string };
}

export type FloatingPanelOpener = (anchor: Element | null, request: FloatingPanelRequest) => FloatingPanelHandle;

let opener: FloatingPanelOpener | null = null;

/** Provide the opener; returns a function that withdraws it. */
export function provideFloatingPanelOpener(next: FloatingPanelOpener): () => void {
  opener = next;
  return () => { if (opener === next) opener = null; };
}

export function canOpenFloatingPanel(): boolean {
  return opener !== null;
}

export function openFloatingPanel(anchor: Element | null, request: FloatingPanelRequest): FloatingPanelHandle | null {
  return opener ? opener(anchor, request) : null;
}
