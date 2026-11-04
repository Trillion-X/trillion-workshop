/** Measure distinct labels once for a caller's immutable data. No visible DOM
 * nodes are created, and the caller can memoize this independently of resizing. */
export function widestTextWidth(texts: Iterable<string>, font: string): number {
  if (typeof document === 'undefined') return 0;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  context.font = font;
  const seen = new Set<string>();
  let width = 0;
  for (const text of texts) {
    if (seen.has(text)) continue;
    seen.add(text);
    width = Math.max(width, context.measureText(text).width);
  }
  return width;
}
