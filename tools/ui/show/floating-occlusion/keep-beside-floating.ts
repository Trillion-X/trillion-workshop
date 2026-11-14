/**
 * Keep an overlay fixed near the viewport bottom (the toast stack) clear of the controls docked there, as close to
 * where it belongs as it can be. `reserveBottomFloatingInset` lists where each docked control sits; a control this
 * overlay does not cover is ignored, a control it covers is given room beside it (the overlay narrows away from it)
 * while at least `minWidth` is left, and only when there is no such room does the overlay rise above it. The answer is
 * three properties on the overlay, `--floating-room-left`, `--floating-room-right` and `--floating-room-lift`, which
 * screen-look turns into its sides and its bottom; nothing here knows what the overlay or the controls are.
 */
import { FLOATING_OCCLUSION_CHANGE, dockedFloatingBoxes } from './reserve-bottom-inset';
import { roomBesideFloating } from './room-beside-floating';

const ROOM_LEFT = '--floating-room-left';
const ROOM_RIGHT = '--floating-room-right';
const LIFT = '--floating-room-lift';

/** Tracks one overlay; the returned function releases it. */
export function keepBesideFloating(node: HTMLElement, options?: { gap?: number; minWidth?: number }): () => void {
  const doc = node.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  const update = () => {
    for (const property of [ROOM_LEFT, ROOM_RIGHT, LIFT]) node.style.removeProperty(property);
    const boxes = dockedFloatingBoxes(doc);
    if (!boxes.length || !node.isConnected) return;
    const room = roomBesideFloating(node.getBoundingClientRect(), boxes, options);
    if (room.left) node.style.setProperty(ROOM_LEFT, `${room.left}px`);
    if (room.right) node.style.setProperty(ROOM_RIGHT, `${room.right}px`);
    if (room.lift) node.style.setProperty(LIFT, `${room.lift}px`);
  };
  let frame = 0;
  const soon = () => { if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; update(); }); };
  doc.addEventListener(FLOATING_OCCLUSION_CHANGE, soon);
  win.addEventListener('resize', soon);
  soon();
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    doc.removeEventListener(FLOATING_OCCLUSION_CHANGE, soon);
    win.removeEventListener('resize', soon);
    for (const property of [ROOM_LEFT, ROOM_RIGHT, LIFT]) node.style.removeProperty(property);
  };
}
