// packages/group/show/SharedCapsuleRoute.tsx
//
// The OPEN half of R12 sharing: what a share link actually resolves to. A product mounts
// this when the URL carries a `#capsule=…` fragment (hasCapsuleLink); it decodes the
// self-contained capsule and renders the read-only board via SharedCapsuleView — no engine,
// no network (the content rides in the link). An invalid/empty link shows a friendly notice
// instead of a blank screen. This closes the round-trip: produce link → open link → see board.
//
// `href` defaults to the live location so a product can mount `<SharedCapsuleRoute />` bare;
// tests and the render harness pass an explicit href for determinism.

import { Container, Text } from '../../ui';
import { decodeShareLink } from '../read-data/share-capsule';
import { SharedCapsuleView } from './SharedCapsuleView';

export interface SharedCapsuleRouteProps {
  /** The URL to read the capsule from. Defaults to the current document location. */
  readonly href?: string;
}

function currentHref(): string {
  return typeof window !== 'undefined' && window.location ? window.location.href : '';
}

export function SharedCapsuleRoute({ href }: SharedCapsuleRouteProps): JSX.Element {
  const capsule = decodeShareLink(href ?? currentHref());
  if (!capsule) {
    return (
      <Container layout="vertical" gap="xs" alignItems="center">
        <Text variant="body-md" weight="semibold">
          This share link is empty or invalid
        </Text>
        <Text variant="body-sm" tone="muted">
          Ask for a fresh link to the board.
        </Text>
      </Container>
    );
  }
  return <SharedCapsuleView capsule={capsule} />;
}
