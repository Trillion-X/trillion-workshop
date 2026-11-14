// bitfield/packages/ai-identity/read-data/read-ai-identity.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// TypeScript interfaces for AI Identity data read from projected owner rows.
// Defines the structure of the primary identity entity and its properties.
//
// =============================================================================

export interface AiIdentity {
  id: string;
  name: string;
  persona: string;
  modelId: string;
  emailHandle: string;
  walletHandle: string;
  status: 'pending_setup' | 'active' | 'disabled';
}

export function decodeAiIdentityFeed(raw: unknown): AiIdentity[] {
  if (!Array.isArray(raw)) return [];

  const identities: AiIdentity[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = readText(row.id);
    if (!id) continue;

    identities.push({
      id,
      name: readText(row.name) ?? 'Assistant',
      persona: readText(row.persona) ?? '',
      modelId: readText(row.modelId) ?? '',
      emailHandle: readText(row.emailHandle) ?? '',
      walletHandle: readText(row.walletHandle) ?? '',
      status: readStatus(row.status),
    });
  }

  return identities;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStatus(value: unknown): AiIdentity['status'] {
  return value === 'active' || value === 'disabled' || value === 'pending_setup'
    ? value
    : 'pending_setup';
}
