// package-set://bitfield-studio/packages/connectable-services/show/ConnectableServicesPanel.tsx
//
// Blind projection renderer for connectable-services. The panel receives
// descriptor-projected human rows and emits owner action intents; it does not
// know provider setup, credential storage, or external execution policy.

import React, { useMemo, useState } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Badge, Button, Card, Container, EmptyPlaceholder, Icon, Input, Text } from '../../../../ui';
import {
  decodeConnectableServicesFeed,
  extractDomain,
  matchConnectableServices,
  type ProjectedActionIntent,
} from '../read-data/read-connectable-services';
import { Link } from 'lucide-react';

export interface ConnectableServicesPanelProps {
  url?: string;
  onActionIntent?: (intent: ProjectedActionIntent) => void;
}

export function ConnectableServicesPanel({
  url: initialUrl = '',
  onActionIntent,
}: ConnectableServicesPanelProps) {
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [searchDomain, setSearchDomain] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rawRows = useBitfieldData();
  const rows = useMemo(() => decodeConnectableServicesFeed(rawRows), [rawRows]);
  const model = useMemo(() => matchConnectableServices(rows, searchDomain), [rows, searchDomain]);
  const loading = rawRows === null;

  const handleDiscover = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setSearchDomain(null);
      setMessage(null);
      return;
    }

    const domain = extractDomain(trimmed);
    setSearchDomain(domain || null);
    setMessage(domain ? null : 'Enter a complete address.');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') handleDiscover();
  };

  return (
    <Container layout="vertical" gap="md">
      <Container layout="horizontal" gap="sm" alignItems="end">
        <Container flex={1}>
          <Input
            placeholder="Enter an address"
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
        </Container>
        <Button onClick={handleDiscover} disabled={!urlInput.trim() || loading} loading={loading}>
          {loading ? 'Loading' : 'Find'}
        </Button>
      </Container>

      {message && (
        <Text variant="body" color="subtle">
          {message}
        </Text>
      )}

      {model.records.length > 0 ? (
        <Container layout="vertical" gap="md">
          <Text variant="label" color="muted">
            {model.records.length} found
          </Text>

          {model.records.map((record) => (
            <Card key={record.id}>
              <Container layout="vertical" gap="sm">
                <Container layout="horizontal" gap="md" alignItems="start">
                  <Container flex={1}>
                    <Text variant="heading-xs">{record.title}</Text>
                    {record.subtitle && (
                      <Text variant="body-xs" color="muted">
                        {record.subtitle}
                      </Text>
                    )}
                  </Container>
                  {record.badges.map((badge) => (
                    <Badge key={badge}>{badge}</Badge>
                  ))}
                </Container>

                {record.supporting_text && (
                  <Text variant="body-xs" color="subtle">
                    {record.supporting_text}
                  </Text>
                )}

                {record.actions.length > 0 && (
                  <Container layout="horizontal" gap="sm" justifyContent="end">
                    {record.actions.map((action) => (
                      <Button
                        key={action.descriptor_id}
                        size="sm"
                        disabled={action.disabled}
                        onClick={() => onActionIntent?.(action)}
                      >
                        <Icon icon={Link} size="sm" />
                        {action.label}
                      </Button>
                    ))}
                  </Container>
                )}
              </Container>
            </Card>
          ))}
        </Container>
      ) : (
        !loading &&
        !message && (
          <EmptyPlaceholder
            icon={Link}
            title="Nothing found"
            description={urlInput.trim() ? 'Try a different address.' : 'Enter an address to search.'}
          />
        )
      )}
    </Container>
  );
}
