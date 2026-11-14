// package-set://bitfield-studio/packages/files/show/FilesSurface.tsx
//
// Generic files surface shell. Source browsers and editors are owner material
// roots; this package does not import their source or own local filesystem work.

import React from 'react';
import { Card, Container, Text } from '../../ui/index.ts';

export interface FilesSurfaceProps {
  title?: string;
}

const FilesSurface = React.forwardRef<HTMLDivElement, FilesSurfaceProps>(
  ({ title = 'Files' }, ref) => {
    return (
      <Container
        ref={ref}
        layout="vertical"
        gap="md"
        padding="none"
        data-files-surface
      >
        <Card variant="nested" padding="md">
          <Text variant="body" weight="medium">{title}</Text>
          <Text variant="label" color="faint" className="mt-1">
            File sources and editors are owner-authored material surfaces. The
            selected file moves through addressed records, not React callbacks
            across package boundaries.
          </Text>
        </Card>
      </Container>
    );
  },
);

FilesSurface.displayName = 'FilesSurface';

export { FilesSurface };
