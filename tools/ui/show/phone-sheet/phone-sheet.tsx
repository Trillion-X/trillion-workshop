// parts/ui/show/phone-sheet/phone-sheet.tsx
//
// NO PRIOR: searched parts/ui, parts/screen-look and src (no bottom-sheet or touch placement; only hint-text
// pointer:coarse toggles), bitfield-packages/packages (calendar and timed-action mention a mobile sheet but ship
// none; ui/index.ts says no BottomSheet exists) and 21st.dev (coss.com Drawer 11442 and wensity Drawer 31360 are
// dialog drawers; their drag-to-dismiss with a handle is adapted here). Anatomy from Amie on Mobbin
// (d055271a-e29a-4014-93f0-3a6b95cd89f6, d00daa2e-1094-48ea-87ba-c1a1ee192586).
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// On a phone every menu, popover and select opens as a sheet at the bottom edge, the way phone apps do: it
// slides up, runs the full width, carries a grip on top, and a swipe down closes it. The shared overlay
// wrappers (coss/ui/menu.tsx, popover.tsx, select.tsx) ask `usePhoneSheet()` and, when it answers yes, pin
// their positioner with `PHONE_SHEET_ATTRIBUTE`, mark their surface with `PHONE_SHEET_SURFACE_ATTRIBUTE`, put
// the primitive's own backdrop under it and `<PhoneSheetGrip />` at its top. The menu, popover or select
// itself is unchanged: its roles, typeahead, arrow keys and closing rules stay its own; only where it sits
// changes. The look lives in screen-look floating-menus.css.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. A phone is a finger plus a small screen (phone-sheet.json): `(pointer: coarse)` and narrower than
//    max_width_px or shorter than max_height_px. A narrow desktop window has a mouse and keeps floating menus;
//    an iPad keeps them; the iPhone app and a phone browser both get sheets, because the test is the screen
//    and the finger, never which app is running.
// 2. Blind: nothing here knows which menu, screen or primitive opened the sheet.
// 3. A swipe down closes the sheet through the primitive's own Escape handling (every Base UI overlay listens
//    for Escape on the document), so a nested sheet closes only itself and every close runs the primitive's
//    own close path (focus return, onOpenChange).
// 4. Distances and speeds are DATA (phone-sheet.json), never constants in the handler.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { useMediaQuery } from '../use-media-query/use-media-query';
import settings from './phone-sheet.json';

/** On the positioner of an overlay drawn as a sheet: the stylesheet pins it to the bottom edge. */
export const PHONE_SHEET_ATTRIBUTE = 'data-phone-sheet';
/** On the element that draws the sheet's surface (its corners, fill and grip). */
export const PHONE_SHEET_SURFACE_ATTRIBUTE = 'data-phone-sheet-surface';
/** On the positioner while a finger drags the sheet, so it follows the finger without easing. */
const DRAGGING_ATTRIBUTE = 'data-phone-sheet-dragging';
/** How far the sheet has been dragged down, read by the stylesheet. */
const DRAG_PROPERTY = '--phone-sheet-drag';

export const PHONE_SHEET_QUERY = `(pointer: coarse) and ((max-width: ${settings.max_width_px}px) or (max-height: ${settings.max_height_px}px))`;

/** True while overlays open as sheets on this screen: a finger and a small screen. */
export function usePhoneSheet(): boolean {
  return useMediaQuery(PHONE_SHEET_QUERY);
}

/** The attributes a positioner and a surface carry while drawn as a sheet; nothing when not. */
export function phoneSheetPositioner(sheet: boolean): Record<string, string> {
  return sheet ? { [PHONE_SHEET_ATTRIBUTE]: '' } : {};
}
export function phoneSheetSurface(sheet: boolean): Record<string, string> {
  return sheet ? { [PHONE_SHEET_SURFACE_ATTRIBUTE]: '' } : {};
}

// The primitive closes on Escape wherever focus is; the event starts at the sheet so a nested sheet is the one asked.
function closeSheet(surface: HTMLElement) {
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

/** The grip at the top of a sheet. Dragging it down moves the sheet with the finger; far or fast enough closes it. */
export function PhoneSheetGrip(): React.ReactElement {
  const grip = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const own = grip.current;
    const surface = own?.closest<HTMLElement>(`[${PHONE_SHEET_SURFACE_ATTRIBUTE}]`);
    const sheet = own?.closest<HTMLElement>(`[${PHONE_SHEET_ATTRIBUTE}]`);
    if (!own || !surface || !sheet) return;
    let press: { id: number; y: number; at: number } | null = null;
    let dragged = 0;
    const settle = () => { sheet.removeAttribute(DRAGGING_ATTRIBUTE); sheet.style.removeProperty(DRAG_PROPERTY); };
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      press = { id: event.pointerId, y: event.clientY, at: event.timeStamp };
      dragged = 0;
      own.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      dragged = Math.max(0, event.clientY - press.y);
      sheet.setAttribute(DRAGGING_ATTRIBUTE, '');
      sheet.style.setProperty(DRAG_PROPERTY, `${dragged}px`);
    };
    const up = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.id) return;
      const speed = dragged / Math.max(1, event.timeStamp - press.at);
      press = null;
      const far = dragged > Math.max(settings.close_distance_px, surface.offsetHeight * settings.close_fraction);
      const fast = dragged > settings.close_distance_px / 4 && speed > settings.close_speed_px_per_ms;
      if (far || fast) { sheet.removeAttribute(DRAGGING_ATTRIBUTE); closeSheet(surface); } else settle();
    };
    const cancel = (event: PointerEvent) => { if (press && event.pointerId === press.id) { press = null; settle(); } };
    own.addEventListener('pointerdown', down);
    own.addEventListener('pointermove', move);
    own.addEventListener('pointerup', up);
    own.addEventListener('pointercancel', cancel);
    return () => {
      own.removeEventListener('pointerdown', down);
      own.removeEventListener('pointermove', move);
      own.removeEventListener('pointerup', up);
      own.removeEventListener('pointercancel', cancel);
    };
  }, []);
  return <div ref={grip} className="phone-sheet-grip" data-phone-sheet-grip="" aria-hidden="true" />;
}
