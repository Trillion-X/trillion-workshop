//
// Purpose:
//   Bounded glass surface with an internal vertical scroll viewport.
//   Feature packages own the content; this component owns only the browser
//   layout invariant needed for renderer-mounted material to remain scrollable.

import React from 'react';
import { Card } from '../card';
import { Container } from '../container';

export interface ScrollableSurfaceProps {
  children: React.ReactNode;
}

export function ScrollableSurface({ children }: ScrollableSurfaceProps) {
  return (
    <Card
      variant="surface"
      padding="none"
      layout="column"
      height="full"
      minHeight="0"
      className="w-full overflow-hidden"
    >
      <Container
        layout="vertical"
        padding="lg"
        overflow="y-auto"
        flex={1}
        height="full"
        minHeight="0"
        width="full"
        data-scrollable-surface-viewport="true"
      >
        {children}
      </Container>
    </Card>
  );
}
