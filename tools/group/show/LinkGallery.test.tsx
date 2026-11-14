// packages/group/show/LinkGallery.test.tsx
//
// Proves the rich-link gallery: N images → N carousel tiles; a single image → one frame (no carousel); empty →
// nothing (null). The image URLs are rendered through MediaFrame (the same renderer the single-image card uses).

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { LinkGallery } from './LinkGallery';

afterEach(() => cleanup());

describe('LinkGallery', () => {
  it('renders one carousel tile per image (a multi-photo post)', () => {
    const { container } = render(<LinkGallery images={['https://x.test/1.jpg', 'https://x.test/2.jpg', 'https://x.test/3.jpg']} label="Post" />);
    expect(container.querySelector('[aria-label="Link gallery"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="gallery image"]').length).toBe(3);
  });

  it('a single image → one frame, not a carousel (no gallery tiles)', () => {
    const { container } = render(<LinkGallery images={['https://x.test/hero.jpg']} label="Post" />);
    expect(container.querySelector('[aria-label="Link gallery"]')).toBeNull(); // no carousel wrapper
    expect(container.querySelectorAll('[aria-label^="gallery image"]').length).toBe(0);
  });

  it('empty → renders nothing', () => {
    const { container } = render(<LinkGallery images={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
