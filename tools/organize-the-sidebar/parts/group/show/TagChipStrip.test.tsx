// @vitest-environment jsdom
// packages/group/show/TagChipStrip.test.tsx
//
// Proof that TagChipStrip renders one stably-coloured chip per tag. Uses react-dom/server to render to
// static markup (no browser) and asserts the chip labels, the deterministic per-tag colour (same tag → same
// bg), and the empty-list → nothing (so a tag-less note is byte-identical).

import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { TagChipStrip } from '../../../show/TagChipStrip.tsx';
import { labelColor } from '../../../do-work/label-color.ts';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body;

describe('TagChipStrip', () => {
  it('renders one chip per tag, each prefixed with # and labelColor-tinted', () => {
    const body = parse(renderToStaticMarkup(<TagChipStrip tags={['tennis', 'clinic']} />));
    const chips = Array.from(body.querySelectorAll('[data-tag-chip]'));
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.textContent)).toEqual(['#tennis', '#clinic']);
    // each chip's background is the deterministic labelColor for that tag (assert on the raw inline style
    // attribute — jsdom re-parses the `background` shorthand, so the string is the robust source of truth).
    expect(chips[0].getAttribute('style')).toContain(`background:${labelColor('tennis').bg}`);
    expect(chips[1].getAttribute('style')).toContain(`background:${labelColor('clinic').bg}`);
  });

  it('gives the SAME tag the SAME colour regardless of position', () => {
    const a = parse(renderToStaticMarkup(<TagChipStrip tags={['x', 'tennis']} />)).querySelectorAll('[data-tag-chip]');
    const b = parse(renderToStaticMarkup(<TagChipStrip tags={['tennis', 'y']} />)).querySelectorAll('[data-tag-chip]');
    const tennisA = Array.from(a).find((c) => c.getAttribute('data-tag-chip') === 'tennis')!;
    const tennisB = Array.from(b).find((c) => c.getAttribute('data-tag-chip') === 'tennis')!;
    expect(tennisA.getAttribute('style')).toBe(tennisB.getAttribute('style')); // order-independent (not palette[i])
  });

  it('renders nothing for an empty tag list', () => {
    expect(renderToStaticMarkup(<TagChipStrip tags={[]} />)).toBe('');
  });
});
