import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Button, Card, Container, Text } from '@/packages/ui';
import { configureAiProvider } from '@/packages/ai-providers/do-work/configure-provider';
import { decodeAiProviderRecords } from '@/packages/ai-providers/read-data/ai-provider-record';
import { decodeCliRegistryFeed, getDefaultModelForVendor } from '@/packages/ai-providers/read-data/read-cli-models';
import { decodeAiProviderOptions } from '@/packages/ai-providers/read-data/read-model-catalog';

export function AiProvidersSurface(): React.ReactElement {
  const providersEntry = useBitfieldData();
  const publishedRecordsEntry = useBitfieldData('published-records');
  const cliRegistryEntry = useBitfieldData('cli-registry');
  const configured = React.useMemo(
    () => decodeAiProviderRecords(providersEntry),
    [providersEntry],
  );
  const providerOptions = React.useMemo(
    () => decodeAiProviderOptions(publishedRecordsEntry),
    [publishedRecordsEntry],
  );
  const clis = React.useMemo(
    () => decodeCliRegistryFeed(cliRegistryEntry),
    [cliRegistryEntry],
  );
  const [pendingVendor, setPendingVendor] = React.useState<string | null>(null);
  const [successVendor, setSuccessVendor] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function useProvider(option: (typeof providerOptions)[number]): Promise<void> {
    setPendingVendor(option.vendor);
    setError(null);
    try {
      await configureAiProvider({
        provider_id: option.providerId,
        name: option.name,
        vendor: option.vendor,
        model: getDefaultModelForVendor(clis, option.vendor) ?? '',
        is_primary: true,
        status: 'configured',
        credential_handle: '',
      });
      setSuccessVendor(option.vendor);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        setSuccessVendor(option.vendor);
      } else {
        setError(message || 'Provider setup could not be saved. Try again.');
      }
    } finally {
      setPendingVendor(null);
    }
  }

  return (
    <Container layout="vertical" gap="md" padding="lg">
      <Text variant="heading">AI Providers</Text>
      <Container layout="grid" gridCols={2} gap="sm">
        {providerOptions.map((option) => {
          const configuredRecord = configured.find((provider) => provider.vendor === option.vendor);
          const pending = pendingVendor === option.vendor;
          const selected = Boolean(configuredRecord || successVendor === option.vendor);
          const defaultModel = getDefaultModelForVendor(clis, option.vendor);
          return (
            <Card
              key={option.vendor}
              variant={selected ? 'accent' : 'surface'}
              padding="md"
              layout="stack"
              selected={selected}
            >
              <Container layout="vertical" gap="xs">
                <Text variant="heading-xs">{option.name}</Text>
                <Text variant="body" color="muted">{option.description}</Text>
                <Text variant="caption" color={configuredRecord ? 'success' : 'muted'}>
                  {selected || configuredRecord
                    ? 'Configured'
                    : defaultModel
                      ? `Default model: ${defaultModel}`
                      : 'Not configured'}
                </Text>
                {error ? <Text variant="caption" color="danger">{error}</Text> : null}
                <Button
                  disabled={pendingVendor !== null}
                  onClick={() => { void useProvider(option); }}
                  size="sm"
                  variant={selected ? 'outline' : 'default'}
                >
                  {pending ? 'Saving...' : selected ? 'Use again' : 'Use this provider'}
                </Button>
              </Container>
            </Card>
          );
        })}
      </Container>
    </Container>
  );
}
