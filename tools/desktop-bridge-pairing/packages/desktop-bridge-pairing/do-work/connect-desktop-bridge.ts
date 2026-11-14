// packages/desktop-bridge-pairing/do-work/connect-desktop-bridge.ts

import { invokeDesktopBridgeCommand } from '@/packages/desktop-bridge-pairing/do-work/invoke-desktop-bridge-command';
import type { DesktopBridgePairingConfig } from '@/packages/desktop-bridge-pairing/read-data/read-desktop-bridge-config';

export async function connectDesktopBridge(config: DesktopBridgePairingConfig): Promise<void> {
  await invokeDesktopBridgeCommand('bridge_connect', {
    gatewayUrl: config.gatewayUrl,
    nodeToken: config.token,
  });
}
