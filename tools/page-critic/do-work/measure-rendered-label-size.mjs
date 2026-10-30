// In-page SVG text geometry for DATA-selected teaching labels. No browser starts
// on import. A caller owns selection and its minimum; size is not comprehension.
export function renderedLabelSizeMeasurements({selector, min_height_px}) {
  if (typeof selector !== 'string' || !selector.trim()
      || !Number.isFinite(min_height_px) || min_height_px <= 0) {
    throw new TypeError('Rendered label measurement needs a selector and positive finite minimum.');
  }
  const visible = element => {
    if (!element.getBoundingClientRect().width || !element.getBoundingClientRect().height) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  return [...document.querySelectorAll(selector)].filter(visible).map(element => {
    const text = (element.textContent || '').trim().replace(/\s+/g, ' ');
    const unavailable = reason => ({element, values: {text, kind: 'unavailable', reason, min_height_px}});
    if (typeof element.getExtentOfChar !== 'function' || typeof element.getScreenCTM !== 'function') {
      return unavailable('selected label has no SVG character geometry');
    }
    try {
      const matrix = element.getScreenCTM();
      if (!matrix || ![matrix.a, matrix.b, matrix.c, matrix.d].every(Number.isFinite)) {
        return unavailable('label screen transform is unavailable');
      }
      // A whole rotated/multiline label's bounding box can be tall despite tiny
      // characters. Measure local glyph height perpendicular to the transformed
      // baseline; shear along that baseline must not inflate the height.
      const baselineScale = Math.hypot(matrix.a, matrix.b);
      if (!Number.isFinite(baselineScale) || baselineScale <= 0) {
        return unavailable('label baseline transform is unavailable');
      }
      const scale = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) / baselineScale;
      const heights = [];
      const count = element.getNumberOfChars();
      if (!Number.isSafeInteger(count) || count < 1 || count > 4096) {
        return unavailable('label character geometry is empty or exceeds its bound');
      }
      for (let index = 0; index < count; index++) {
        const box = element.getExtentOfChar(index);
        if (box.width > 0 && box.height > 0) heights.push(box.height * scale);
      }
      const height_px = Math.min(...heights);
      if (!Number.isFinite(height_px) || height_px <= 0) return unavailable('label glyph height is unavailable');
      return {element, values: {text, kind: height_px < min_height_px ? 'too-small' : 'measured', height_px, min_height_px}};
    } catch { return unavailable('label character geometry could not be read'); }
  });
}
