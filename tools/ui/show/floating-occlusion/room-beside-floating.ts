/**
 * Where an overlay near the viewport bottom goes so it covers none of the controls docked there: room beside each
 * covered control (the overlay narrows away from it) while at least `minWidth` is left, otherwise a lift above the
 * highest of them. Pure geometry in viewport pixels; `keepBesideFloating` measures and applies it.
 */
/** Where the overlay would sit with no room given, and the docked controls: the room each side, and the lift. */
export function roomBesideFloating(
  overlay: { left: number; right: number; bottom: number },
  boxes: readonly { left: number; right: number; top: number }[],
  { gap = 8, minWidth = 240 }: { gap?: number; minWidth?: number } = {},
): { left: number; right: number; lift: number } {
  const covered = boxes.filter(box => box.top < overlay.bottom && box.left < overlay.right && box.right > overlay.left);
  if (!covered.length) return { left: 0, right: 0, lift: 0 };
  const middle = (overlay.left + overlay.right) / 2;
  let left = 0;
  let right = 0;
  for (const box of covered) {
    if ((box.left + box.right) / 2 < middle) left = Math.max(left, Math.ceil(box.right + gap - overlay.left));
    else right = Math.max(right, Math.ceil(overlay.right - box.left + gap));
  }
  if (overlay.right - overlay.left - left - right >= minWidth) return { left, right, lift: 0 };
  return { left: 0, right: 0, lift: Math.max(...covered.map(box => Math.ceil(overlay.bottom - box.top + gap))) };
}
