// packages/group/show/LinkGallery.tsx
//
// The rich-link GALLERY — the product surface for `parseOpenGraphImages` (b195, R11). A link to a multi-photo
// post (Pinterest board, Instagram carousel, an article with several og:image tags) is not one hero image: this
// renders the whole set as a horizontal carousel of tiles, each through the SAME `MediaFrame` the single-image
// link card uses (L100/L065 — one image renderer, no raw <img>). One image → a single 16:9 frame (identical to
// today's card); many → the scrollable carousel. Empty → nothing. Blind over the list (L090). Stateless.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { Container, } from '../../ui';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';

export interface LinkGalleryProps {
  /** Absolutized, safety-filtered image URLs (from `parseOpenGraphImages`). */
  readonly images: readonly string[];
  /** Accessible label for each frame (the link title / site). */
  readonly label?: string;
}

/** Render the link's image set: nothing / a single 16:9 frame / a horizontal carousel of square tiles. */
export function LinkGallery({ images, label }: LinkGalleryProps) {
  if (images.length === 0) return null;
  if (images.length === 1) {
    return <MediaFrame url={images[0]} mediaType="image" label={label} transform={{ aspectRatio: '16:9', keepAspectRatio: false }} />;
  }
  return (
    <Container layout="horizontal" gap="xs" aria-label="Link gallery" style={{ overflowX: 'auto' }}>
      {images.map((url, i) => (
        <Container key={`${url}-${i}`} aria-label={`gallery image ${i + 1}`} style={{ flex: '0 0 auto', width: 150 }}>
          <MediaFrame url={url} mediaType="image" label={label} transform={{ aspectRatio: '1:1', keepAspectRatio: false }} />
        </Container>
      ))}
    </Container>
  );
}
