// parts/ui/show/visible-viewport/safe-area-insets.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for 'safe-area-inset', 'readSafeArea' and
// 'safeAreaInsets' (only CSS env() uses in notifications.css and LandingMinimap.tsx) and the 21st.dev catalog for
// "safe area insets hook" (no match).
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The window's safe areas as numbers: the part of each edge a phone keeps for its
// status bar, notch, rounded corners and home indicator (0 on a desktop). CSS can
// say env(safe-area-inset-top), but a floating card placed by script (a tour card,
// a hover card, a menu) needs pixels, so it can keep clear of those edges the way
// the workspace's own box does.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The values come from the browser's own env(safe-area-inset-*), read through
//    one hidden element, never from a guessed device size.
// 2. Without a document (a server render or a test without one) every inset is 0.
// 3. `insetFrame` never returns a negative size.
// 4. The page is read once per window size: the probe forces the browser to work out every style on the page, and
//    each sidebar row's hover card asks for the insets as it draws, so reading on every ask cost 2.7 s of one long
//    task on a 1280-wide open (2026-10-05). The insets change only with the window (a rotation, a resize, the
//    on-screen keyboard), so a resize of the window or its visible part forgets the read and the next ask reads again.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const NONE: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const EDGES = ['top', 'right', 'bottom', 'left'] as const;

// The last read, by document, until its window changes size (invariant 4).
const lastRead = new WeakMap<Document, SafeAreaInsets>();
const forgetting = new WeakSet<Document>();
function forgetOnResize(doc: Document, view: Window) {
  if (forgetting.has(doc)) return;
  forgetting.add(doc);
  const forget = () => { lastRead.delete(doc); };
  view.addEventListener('resize', forget);
  view.addEventListener('orientationchange', forget);
  view.visualViewport?.addEventListener('resize', forget);
}

/** The window's safe-area insets in CSS pixels, as they are for the window's current size (invariant 4). */
export function readSafeAreaInsets(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): SafeAreaInsets {
  const body = doc?.body;
  const view = doc?.defaultView;
  if (!doc || !body || !view) return NONE;
  const known = lastRead.get(doc);
  if (known) return known;
  forgetOnResize(doc, view);
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;${EDGES.map(edge => `padding-${edge}:env(safe-area-inset-${edge},0px)`).join(';')}`;
  body.append(probe);
  const style = view.getComputedStyle(probe);
  const read = (edge: typeof EDGES[number]) => Number.parseFloat(style.getPropertyValue(`padding-${edge}`)) || 0;
  const insets = { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
  probe.remove();
  lastRead.set(doc, insets);
  return insets;
}

/** Each edge's safe area plus `gap`: the padding a floating card keeps from the window's edges. */
export function safeEdgePadding(gap: number, insets: SafeAreaInsets = readSafeAreaInsets()): SafeAreaInsets {
  return { top: insets.top + gap, right: insets.right + gap, bottom: insets.bottom + gap, left: insets.left + gap };
}

/** The part of a frame (width × height, in its own coordinates) left once the insets are taken off its edges. */
export function insetFrame(frame: { readonly width: number; readonly height: number }, insets: SafeAreaInsets): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, frame.width - insets.left - insets.right),
    height: Math.max(0, frame.height - insets.top - insets.bottom),
  };
}
