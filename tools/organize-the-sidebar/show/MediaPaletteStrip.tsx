// packages/group/show/MediaPaletteStrip.tsx
//
// The image colour-palette surface (b102): a thin strip of swatches showing the dominant colours of an image,
// extracted by the `median-cut-palette` primitive. `PaletteSwatches` is the pure presentational half (renders
// a swatch per colour — jsdom-testable, no canvas); `useImagePalette` is the extraction half (loads the image,
// draws it to an offscreen canvas, samples pixels, runs median-cut). Extraction fails CLOSED — a cross-origin
// (CORS-tainted) image, a missing canvas (SSR/jsdom), or any error yields `[]`, so the strip simply renders
// nothing rather than throwing. So a mood board can read its hero image's palette (and feed it to a recolour).
import React from 'react';
import { Container, Text } from '../../ui/index.ts';
import { medianCutPalette, pixelsFromImageData } from '../do-work/median-cut-palette.ts';

export interface PaletteSwatchesProps {
  readonly colors: readonly string[];
  readonly flagAttr?: string;
}

/** Pure: a row of colour swatches (one per colour). Empty list → renders nothing (byte-identical when off). */
export function PaletteSwatches({ colors, flagAttr = 'data-palette-strip' }: PaletteSwatchesProps) {
  if (colors.length === 0) return null;
  return (
    <Container
      layout="horizontal"
      gap="none"
      {...{ [flagAttr]: 'true' }}
      style={{ position: 'absolute', left: 6, right: 6, bottom: 6, height: 14, borderRadius: 7, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.35)' }}
    >
      {colors.map((c, i) => (
        <Container key={`${c}-${i}`} data-swatch={c} style={{ flex: 1, height: '100%', background: c }}>
          <Text variant="caption" style={{ opacity: 0 }}>{c}</Text>
        </Container>
      ))}
    </Container>
  );
}

/**
 * Extract up to `count` dominant colours from `url`. Loads the image (anonymous CORS so a permissive host is
 * usable), draws it small onto an offscreen canvas, and runs median-cut over the sampled pixels. Any failure
 * (no canvas, CORS taint on getImageData, load error) → `[]` (fail closed — never throws into render).
 */
export function useImagePalette(url: string | undefined, count = 5): string[] {
  const [colors, setColors] = React.useState<string[]>([]);
  React.useEffect(() => {
    setColors([]);
    if (!url || typeof document === 'undefined') return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const W = 64; // downscale — median-cut needs colour distribution, not resolution
        const scale = img.width > 0 ? Math.min(1, W / img.width) : 1;
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h); // throws on a CORS-tainted canvas → caught below
        const palette = medianCutPalette(pixelsFromImageData(data, 1), count);
        if (!cancelled) setColors(palette);
      } catch {
        if (!cancelled) setColors([]); // fail closed (tainted canvas / unsupported) → no strip
      }
    };
    img.onerror = () => {
      if (!cancelled) setColors([]);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, count]);
  return colors;
}

export interface MediaPaletteStripProps {
  readonly url: string | undefined;
  readonly count?: number;
}

/** The wired strip: extract `url`'s palette and render it. Nothing to show (loading/failure) → renders null. */
export function MediaPaletteStrip({ url, count = 5 }: MediaPaletteStripProps) {
  const colors = useImagePalette(url, count);
  return <PaletteSwatches colors={colors} />;
}
