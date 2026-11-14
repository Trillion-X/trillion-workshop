// packages/ui/show/rich-text-paint/index.ts
//
// Public surface of the rich-text paint primitive: paint any text run (or a
// single letter) with the infinite visual-layer-stack paint, clipped to glyphs.

export { RichTextPaintControl } from './RichTextPaintControl';
export type { RichTextPaintControlProps } from './RichTextPaintControl';
export {
  PAINT_STACK_ATTR,
  cssPropsToText,
  resolvePaintTarget,
  setSpanPaint,
  readSpanStack,
  normalizePaintSpans,
} from './apply-selection-paint';
