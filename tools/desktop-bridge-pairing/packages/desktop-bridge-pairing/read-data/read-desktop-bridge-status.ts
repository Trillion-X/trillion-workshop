// packages/desktop-bridge-pairing/read-data/read-desktop-bridge-status.ts
//
// Reads bridge status through the currently exposed desktop bridge command seam.

import { invokeDesktopBridgeCommand } from '../do-work/invoke-desktop-bridge-command';

export interface DesktopBridgeStatus {
  connected: boolean;
  gateway_url: string;
  connected_clients: number;
}

export async function readDesktopBridgeStatus(): Promise<DesktopBridgeStatus> {
  return invokeDesktopBridgeCommand<DesktopBridgeStatus>('bridge_status');
}
