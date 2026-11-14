/** Metadata only. Installation and completion capability are not inference proof. */
export type LocalModelInventory = {
  kind: 'local-model-inventory';
  provider_ref: 'ai_provider:ollama';
  status: 'current' | 'unavailable';
  observed_at_ms: number;
  expires_at_ms: number;
  models: { id: string; descriptor_ref: string; digest: string; capabilities: string[] }[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function installedModelCandidates(tags: unknown): { id: string; digest: string }[] {
  const rows = object(tags)?.models;
  if (!Array.isArray(rows) || rows.length > 128) throw new Error('Invalid local model inventory');
  const seen = new Set<string>();
  return rows.map((value) => {
    const row = object(value);
    const id = row?.name;
    const digest = row?.digest;
    if (typeof id !== 'string' || !id.trim() || id.length > 256
      || typeof digest !== 'string' || !digest.trim() || digest.length > 256 || seen.has(id)) {
      throw new Error('Invalid local model identity');
    }
    seen.add(id);
    return { id, digest };
  });
}

export function deriveLocalModelInventory(input: {
  tags: unknown;
  details: readonly { id: string; body: unknown }[];
  observedAtMs: number;
}): LocalModelInventory {
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) throw new Error('Invalid observation time');
  const unavailable: LocalModelInventory = {
    kind: 'local-model-inventory', provider_ref: 'ai_provider:ollama', status: 'unavailable',
    observed_at_ms: input.observedAtMs, expires_at_ms: input.observedAtMs,
    models: [],
  };
  try {
    const candidates = installedModelCandidates(input.tags);
    const details = new Map(input.details.map((row) => [row.id, row.body]));
    if (details.size !== input.details.length || details.size !== candidates.length) return unavailable;
    const models: LocalModelInventory['models'] = [];
    for (const candidate of candidates) {
      const capabilities = object(details.get(candidate.id))?.capabilities;
      if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) return unavailable;
      if (capabilities.includes('completion')) models.push({ ...candidate,
        descriptor_ref: `ai-model-descriptor:ollama:${candidate.id}`, capabilities: [...new Set(capabilities)] });
    }
    return { ...unavailable, status: 'current', expires_at_ms: input.observedAtMs + 300_000, models };
  } catch {
    return unavailable;
  }
}
