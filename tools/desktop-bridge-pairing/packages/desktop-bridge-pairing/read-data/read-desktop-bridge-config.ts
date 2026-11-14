// packages/desktop-bridge-pairing/read-data/read-desktop-bridge-config.ts
//
// Pure payload decoding for the descriptor-bound desktop bridge config records.

export interface DesktopBridgePairingConfig {
  ok: boolean;
  gatewayUrl: string;
  nodeId: string;
  token: string;
  error?: string;
}

const BRIDGE_CONFIG_FIELDS = {
  'prop:bridge_config:gateway_url': 'gatewayUrl',
  'prop:bridge_config:node_id': 'nodeId',
  'prop:bridge_config:token': 'token',
} as const;

type BridgeConfigField = (typeof BRIDGE_CONFIG_FIELDS)[keyof typeof BRIDGE_CONFIG_FIELDS];

interface DesktopBridgeConfigRow {
  subject_id?: unknown;
  property_id?: unknown;
  value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function decodeDesktopBridgeConfigFeed(raw: unknown): DesktopBridgePairingConfig[] {
  if (!Array.isArray(raw)) return [];

  const configs = new Map<string, Partial<Record<BridgeConfigField, string>>>();

  for (const row of raw) {
    if (!isRecord(row)) continue;

    const entry = row as DesktopBridgeConfigRow;
    if (typeof entry.property_id !== 'string') continue;

    const field = BRIDGE_CONFIG_FIELDS[entry.property_id as keyof typeof BRIDGE_CONFIG_FIELDS];
    if (!field) continue;

    const subjectId = typeof entry.subject_id === 'string' ? entry.subject_id : '';
    const config = configs.get(subjectId) ?? {};
    config[field] = typeof entry.value === 'string' ? entry.value : String(entry.value ?? '');
    configs.set(subjectId, config);
  }

  return [...configs.values()].map((config) => ({
    ok: true,
    gatewayUrl: config.gatewayUrl ?? '',
    nodeId: config.nodeId ?? '',
    token: config.token ?? '',
  }));
}
