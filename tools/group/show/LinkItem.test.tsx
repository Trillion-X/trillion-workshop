// packages/group/show/LinkItem.test.tsx
//
// #204/#205/#206 — the LinkItem renderer's DATA contract: it reads the raw href
// (item.src) + the self-describing extra.linkPreview DATA and renders the Bento/Hashnode
// card (favicon mark, title, domain subtitle, description, and — once enriched — a 16:9
// thumbnail). Proven here without the enrichment fetch (which is owned externally): we
// seed the DATA the enrichment WOULD write and assert the render honours it.
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { rendererForKind } from './item-renderers';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

const linkItem = (extra?: Record<string, unknown>): BoardItem =>
  ({ kind: 'link', memberId: 'lk1', x: 0, y: 0, w: 260, h: 160, src: 'https://www.figma.com/community', extra } as unknown as BoardItem);

const Link = rendererForKind('link');

describe('LinkItem renderer', () => {
  it('shows the domain as the title when unenriched (no fake data)', () => {
    const { getByText } = render(<Link item={linkItem()} selected={false} />);
    expect(getByText('figma.com')).not.toBeNull();
  });

  it('renders the enriched TITLE + description from extra.linkPreview DATA', () => {
    const { getByText } = render(
      <Link item={linkItem({ linkPreview: { title: 'Figma Community', description: 'Explore files' } })} selected={false} />,
    );
    expect(getByText('Figma Community')).not.toBeNull(); // enriched title wins
    expect(getByText('figma.com')).not.toBeNull(); // domain drops to the subtitle line
    expect(getByText('Explore files')).not.toBeNull();
  });

  it('renders a THUMBNAIL image (MediaFrame) when extra.linkPreview.image is present (#206)', () => {
    const image = 'https://cdn.example.com/figma-og.png';
    const { container } = render(<Link item={linkItem({ linkPreview: { title: 'Figma', image } })} selected={false} />);
    const img = container.querySelector(`img[src="${image}"]`);
    expect(img).not.toBeNull(); // the 16:9 preview thumbnail rendered from DATA
  });

  it('shows NO thumbnail when there is no preview image (text-only card)', () => {
    const { container } = render(<Link item={linkItem({ linkPreview: { title: 'Figma' } })} selected={false} />);
    // The only img allowed is the favicon mark (s2/favicons) — never a preview thumbnail.
    const previewImg = Array.from(container.querySelectorAll('img')).filter(
      (el) => !String(el.getAttribute('src') || '').includes('s2/favicons'),
    );
    expect(previewImg.length).toBe(0);
  });

  it('always exposes an Open control for a link with an href', () => {
    const { getByLabelText } = render(<Link item={linkItem()} selected={false} />);
    expect(getByLabelText('Open link')).not.toBeNull();
  });
});
