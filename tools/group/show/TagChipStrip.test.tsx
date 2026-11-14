// @vitest-environment jsdom
// packages/group/show/TagChipStrip.test.tsx
//
// Proof that TagChipStrip renders one stably-coloured chip per tag. Uses react-dom/server to render to
// static markup (no browser) and asserts the chip labels, the deterministic per-tag colour (same tag → same
// bg), and the empty-list → nothing (so a tag-less note is byte-identical).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { TagChipStrip } from './TagChipStrip';
import { labelColor } from '../do-work/label-color';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body;

describe('TagChipStrip', () => {
  it('renders one chip per tag, each prefixed with # and labelColor-tinted', () => {
    const body = parse(renderToStaticMarkup(<TagChipStrip tags={['pottery', 'clinic']} />));
    const chips = Array.from(body.querySelectorAll('[data-tag-chip]'));
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.textContent)).toEqual(['#pottery', '#clinic']);
    // each chip's background is the deterministic labelColor for that tag (assert on the raw inline style
    // attribute — jsdom re-parses the `background` shorthand, so the string is the robust source of truth).
    expect(chips[0].getAttribute('style')).toContain(`background:${labelColor('pottery').bg}`);
    expect(chips[1].getAttribute('style')).toContain(`background:${labelColor('clinic').bg}`);
  });

  it('gives the SAME tag the SAME colour regardless of position', () => {
    const a = parse(renderToStaticMarkup(<TagChipStrip tags={['x', 'pottery']} />)).querySelectorAll('[data-tag-chip]');
    const b = parse(renderToStaticMarkup(<TagChipStrip tags={['pottery', 'y']} />)).querySelectorAll('[data-tag-chip]');
    const potteryA = Array.from(a).find((c) => c.getAttribute('data-tag-chip') === 'pottery')!;
    const potteryB = Array.from(b).find((c) => c.getAttribute('data-tag-chip') === 'pottery')!;
    expect(potteryA.getAttribute('style')).toBe(potteryB.getAttribute('style')); // order-independent (not palette[i])
  });

  it('renders nothing for an empty tag list', () => {
    expect(renderToStaticMarkup(<TagChipStrip tags={[]} />)).toBe('');
  });
});
