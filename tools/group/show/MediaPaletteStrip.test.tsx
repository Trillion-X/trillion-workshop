// @vitest-environment jsdom
// packages/group/show/MediaPaletteStrip.test.tsx
//
// Proof of the pure presentational half — PaletteSwatches renders one swatch per colour with that colour as
// its background, and renders nothing for an empty palette (so an image with the strip off / a failed
// extraction is byte-identical). The canvas extraction (useImagePalette) is proven end-to-end in the
// Chromium harness (jsdom has no real canvas getImageData).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { PaletteSwatches } from './MediaPaletteStrip';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body;

describe('PaletteSwatches', () => {
  it('renders one swatch per colour, each with that colour as its background', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff'];
    const body = parse(renderToStaticMarkup(<PaletteSwatches colors={colors} />));
    const swatches = Array.from(body.querySelectorAll('[data-swatch]'));
    expect(swatches).toHaveLength(3);
    expect(swatches.map((s) => s.getAttribute('data-swatch'))).toEqual(colors);
    expect(swatches[0].getAttribute('style')).toContain('background:#ff0000');
  });

  it('renders nothing for an empty palette (off / failed extraction → byte-identical)', () => {
    expect(renderToStaticMarkup(<PaletteSwatches colors={[]} />)).toBe('');
  });
});
