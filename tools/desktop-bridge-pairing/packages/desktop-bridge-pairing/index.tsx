import React from 'react';
import { DesktopBridgePairingPanel } from '@/packages/desktop-bridge-pairing/show/DesktopBridgePairingPanel';

export { DesktopBridgePairingPanel } from '@/packages/desktop-bridge-pairing/show/DesktopBridgePairingPanel';
export type { DesktopBridgeStatus } from '@/packages/desktop-bridge-pairing/read-data/read-desktop-bridge-status';
export type { DesktopBridgePairingConfig } from '@/packages/desktop-bridge-pairing/read-data/read-desktop-bridge-config';

export default function DesktopBridgePairing() {
  return <DesktopBridgePairingPanel />;
}
