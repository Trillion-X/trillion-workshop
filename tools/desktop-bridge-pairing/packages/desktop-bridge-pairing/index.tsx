import React from 'react';
import { DesktopBridgePairingPanel } from './show/DesktopBridgePairingPanel';

export { DesktopBridgePairingPanel } from './show/DesktopBridgePairingPanel';
export type { DesktopBridgeStatus } from './read-data/read-desktop-bridge-status';
export type { DesktopBridgePairingConfig } from './read-data/read-desktop-bridge-config';

export default function DesktopBridgePairing() {
  return <DesktopBridgePairingPanel />;
}
