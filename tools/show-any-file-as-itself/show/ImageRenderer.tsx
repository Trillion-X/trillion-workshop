// package-set://bitfield-studio/packages/file-content-renderer/show/ImageRenderer.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders image files inline with dimensions display. Uses native <img>
// element (correct for image content) with error handling and optional
// maxHeight constraint.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Image src uses an object URL created from local file bytes
// 2. Track natural dimensions via onLoad event
// 3. Display dimensions as faint subtitle: "1920 x 1080"
// 4. Error state: show ImageOff icon + error message if load fails
// 5. Max height constraint with object-contain for aspect ratio preservation
// 6. Wrapped in Card with nested styling
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { Card, Text, Icon, Container, ImageBlock } from '../../ui';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ImageRendererProps {
  filePath: string;
  bytes?: Uint8Array;
  maxHeight?: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ImageRenderer({
  filePath,
  bytes,
  maxHeight = '24rem',
  mimeType = 'application/octet-stream',
}: ImageRendererProps) {
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [hasError, setHasError] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let nextUrl: string | null = null;

    setHasError(false);
    setDimensions(null);
    setImageUrl(null);

    if (!bytes) {
      setHasError(true);
      return () => {
        isCancelled = true;
      };
    }

    nextUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    setImageUrl(nextUrl);

    return () => {
      isCancelled = true;
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [bytes, filePath, mimeType]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  };

  const handleImageError = () => {
    setHasError(true);
  };

  if (hasError) {
    return (
      <Card variant="nested" padding="sm">
        <Container layout="vertical" gap="sm">
          <Container layout="horizontal" gap="sm">
            <Icon name="ImageOff" size="sm" color="faint" />
            <Text variant="body-xs" color="faint">
              Failed to load image
            </Text>
          </Container>
        </Container>
      </Card>
    );
  }

  if (!imageUrl) {
    return (
      <Card variant="nested" padding="sm">
        <Container layout="vertical" gap="sm">
          <Text variant="body-xs" color="faint">
            Loading image…
          </Text>
        </Container>
      </Card>
    );
  }

  return (
    <Card variant="nested" padding="sm">
      <Container layout="vertical" gap="sm">
        <ImageBlock
          src={imageUrl}
          alt={filePath}
          onLoad={handleImageLoad}
          onError={handleImageError}
          maxHeight={maxHeight}
          objectFit="contain"
          rounded="lg"
        />
        {dimensions && (
          <Text variant="label" color="faint">
            {dimensions.width} × {dimensions.height}
          </Text>
        )}
      </Container>
    </Card>
  );
}
