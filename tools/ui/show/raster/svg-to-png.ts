// packages/ui/show/raster/svg-to-png.ts
//
// =============================================================================
// PURPOSE — the universal "rasterize an SVG string to a PNG Blob" capability.
// =============================================================================
//
// "Turn a vector document into pixels" is a browser-universal capability, not a
// board concept (L088 — shared UI bedrock). Any surface that produces an SVG
// (an exported board, a generated chart, a diagram) rasterizes through ONE
// implementation of the Image → canvas.drawImage → toBlob path.
//
// This is the thin browser-API layer Codex predicted on top of the pure
// `boardToSvg` export contract (#142): the deterministic, unit-testable work is
// the SVG string; this file just paints that string onto a canvas. The one bit
// of logic it owns — reading the document's pixel size — is the PURE,
// unit-testable `parseSvgSize` seam.
//
// CONSTRAINT: an SVG rendered through `new Image()` only resolves `<image>`
// children whose href is a `data:` URL or same-origin. The CALLER is responsible
// for inlining cross-origin image srcs to data URLs BEFORE building the SVG —
// an un-inlined external image either fails to load or taints the canvas (which
// makes `toBlob` throw). This layer assumes the SVG is already self-contained.
// =============================================================================

const FALLBACK_SIZE = { width: 800, height: 600 } as const;

/** PURE: read the pixel size off the `width="…" height="…"` attributes that a
 *  serialized SVG document carries (the `boardToSvg` contract always emits them).
 *  Falls back to 800×600 when an attribute is missing or non-numeric. */
export function parseSvgSize(svg: string): { width: number; height: number } {
  const width = svg.match(/\bwidth="(\d+(?:\.\d+)?)"/);
  const height = svg.match(/\bheight="(\d+(?:\.\d+)?)"/);
  const w = width ? Number(width[1]) : NaN;
  const h = height ? Number(height[1]) : NaN;
  return {
    width: Number.isFinite(w) && w > 0 ? w : FALLBACK_SIZE.width,
    height: Number.isFinite(h) && h > 0 ? h : FALLBACK_SIZE.height,
  };
}

/** Wrap an SVG document string as a `data:` URL — usable as an `<img>`/MediaFrame
 *  `src` for an inline preview/thumbnail (no network, no blob lifecycle). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface SvgToPngOptions {
  /** Pixel density multiplier (default 2 — retina-crisp). */
  readonly scale?: number;
  /** Page fill painted under the SVG before drawing (PNG has no transparency
   *  page by default — supply white for an opaque export). Absent → transparent. */
  readonly background?: string;
}

/** Rasterize a self-contained SVG document string to a PNG `Blob`. */
export async function svgToPngBlob(svg: string, opts: SvgToPngOptions = {}): Promise<Blob> {
  const scale = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : 2;
  const { width, height } = parseSvgSize(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg-to-png: source SVG failed to load as an image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('svg-to-png: 2d canvas context unavailable');
    if (typeof opts.background === 'string' && opts.background.length > 0) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('svg-to-png: canvas.toBlob returned null'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
