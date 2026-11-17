// packages/desktop-bridge-pairing/show/DesktopBridgePairingPanel.tsx

import * as React from 'react';
import { Radio as RadioIcon, Users } from 'lucide-react';
import { Button, Card, CodeDisplay, Container, Icon, StatusDot, Text } from '../../../../ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { connectDesktopBridge } from '../do-work/connect-desktop-bridge';
import { disconnectDesktopBridge } from '../do-work/disconnect-desktop-bridge';
import { readDesktopBridgePairingCode } from '../do-work/read-desktop-bridge-pairing-code';
import {
  decodeDesktopBridgeConfigFeed,
  type DesktopBridgePairingConfig,
} from '../read-data/read-desktop-bridge-config';
import { readDesktopBridgeStatus } from '../read-data/read-desktop-bridge-status';

export function DesktopBridgePairingPanel() {
  const [connected, setConnected] = React.useState(false);
  const [connectedClients, setConnectedClients] = React.useState(0);
  const [pairingCode, setPairingCode] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const configRef = React.useRef<DesktopBridgePairingConfig | null>(null);
  const bridgeConfigEntry = useBitfieldData();
  const bridgeConfigs = React.useMemo(
    () => decodeDesktopBridgeConfigFeed(bridgeConfigEntry),
    [bridgeConfigEntry],
  );

  React.useEffect(() => {
    if (bridgeConfigs.length > 0) {
      configRef.current = bridgeConfigs[0];
    }
  }, [bridgeConfigs]);

  React.useEffect(() => {
    const pollStatus = async () => {
      try {
        const status = await readDesktopBridgeStatus();
        setConnected(status.connected);
        setConnectedClients(status.connected_clients);

        if (status.connected) {
          const code = await readDesktopBridgePairingCode();
          if (code) setPairingCode(code);
        } else {
          setPairingCode('');
        }
      } catch (_e) {
        // Desktop bridge commands exist only inside the desktop shell.
      }
    };

    const interval = setInterval(pollStatus, 2000);
    pollStatus();
    return () => clearInterval(interval);
  }, []);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);

    try {
      if (!configRef.current) {
        throw new Error('Bridge configuration unavailable - desktop app required');
      }

      await connectDesktopBridge(configRef.current);
      setConnected(true);
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    setError(null);

    try {
      await disconnectDesktopBridge();
      setConnected(false);
      setConnectedClients(0);
      setPairingCode('');
      configRef.current = null;
    } catch (e) {
      setError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Disconnection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container layout="vertical" gap="md" padding="md">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Icon icon={RadioIcon} />
        <Text as="h2" variant="heading-lg">
          Desktop Bridge
        </Text>
      </Container>

      <Card variant="surface" padding="md">
        <Container layout="vertical" gap="md">
          <Container layout="horizontal" gap="sm" alignItems="center">
            <StatusDot status={connected ? 'success' : 'idle'} size="md" />
            <Text>{connected ? 'Connected to Gateway' : 'Disconnected'}</Text>
          </Container>

          {connected && (
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={Users} />
              <Text>
                {connectedClients} {connectedClients === 1 ? 'device' : 'devices'} paired
              </Text>
            </Container>
          )}

          {error && (
            <Text color="error" variant="body-xs">
              {error}
            </Text>
          )}
        </Container>
      </Card>

      {!connected ? (
        <Button onClick={handleConnect} disabled={loading} variant="primary">
          {loading ? 'Connecting...' : 'Connect to Gateway'}
        </Button>
      ) : (
        <Button onClick={handleDisconnect} disabled={loading} variant="secondary">
          {loading ? 'Disconnecting...' : 'Disconnect'}
        </Button>
      )}

      {connected && pairingCode && (
        <Card variant="surface" padding="md">
          <Container layout="vertical" gap="md" alignItems="center">
            <Text variant="label">Enter this code on your phone</Text>
            <CodeDisplay code={pairingCode} size="lg" />
            <Text variant="body-xs" color="muted">
              Open Bitfield on your phone and enter this pairing code
            </Text>
          </Container>
        </Card>
      )}
    </Container>
  );
}
