// packages/desktop-bridge-pairing/do-work/read-desktop-bridge-pairing-code.ts

import { invokeDesktopBridgeCommand } from './invoke-desktop-bridge-command';

export async function readDesktopBridgePairingCode(): Promise<string> {
  return invokeDesktopBridgeCommand<string>('bridge_pairing_code');
}
