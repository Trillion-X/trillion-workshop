// packages/desktop-bridge-pairing/do-work/disconnect-desktop-bridge.ts

import { invokeDesktopBridgeCommand } from '@/packages/desktop-bridge-pairing/do-work/invoke-desktop-bridge-command';

export async function disconnectDesktopBridge(): Promise<void> {
  await invokeDesktopBridgeCommand('bridge_disconnect');
}
