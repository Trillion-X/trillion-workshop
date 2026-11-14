import React from 'react';
import { Badge, Button, Card, Container, Text, mountReactSurface } from '@/packages/ui';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

type SharedRoomConnectionLinks = {
  appUrl?: string | null;
  browserUrl?: string | null;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function linksFromProps(props: Record<string, unknown>): SharedRoomConnectionLinks {
  const links = props.links && typeof props.links === 'object' ? props.links as Record<string, unknown> : props;
  return {
    appUrl: text(links.appUrl),
    browserUrl: text(links.browserUrl),
  };
}

function copyText(value: string) {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

function LinkQr({ value }: { value: string }) {
  return (
    <div
      aria-label="Room join QR code payload"
      style={{
        alignItems: 'center',
        aspectRatio: '1',
        background: '#fffefa',
        borderRadius: 24,
        color: '#102017',
        display: 'grid',
        fontSize: 13,
        fontWeight: 900,
        overflowWrap: 'anywhere',
        padding: 18,
        textAlign: 'center',
      }}
    >
      {value}
    </div>
  );
}

function SharedRoomConnectionSurface({ props }: { props: Record<string, unknown> }) {
  const links = linksFromProps(props);
  const primaryUrl = links.appUrl ?? links.browserUrl;
  const browserUrl = links.browserUrl ?? '';

  return (
    <Container layout="vertical" gap="md" width="full">
      <Card padding="lg">
        <Container layout="vertical" gap="sm">
          <Badge variant="success">Primary path: opens the installed Bitfield app</Badge>
          <Text variant="heading">Join this room in Bitfield</Text>
          <Text tone="muted">Scan or copy the app link to open the shared room in the installed app.</Text>
          <LinkQr value={primaryUrl} />
          <Button type="button" onClick={() => copyText(primaryUrl)}>Copy app link</Button>
        </Container>
      </Card>
      <Card padding="md">
        <Container layout="vertical" gap="sm">
          <Text variant="label">Mac browser fallback</Text>
          <Text tone="muted">{browserUrl}</Text>
          <Button type="button" variant="secondary" onClick={() => copyText(browserUrl)}>Copy browser fallback</Button>
        </Container>
      </Card>
    </Container>
  );
}

export function mountSharedRoomConnection({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <SharedRoomConnectionSurface props={props} />);
}

export default mountSharedRoomConnection;
