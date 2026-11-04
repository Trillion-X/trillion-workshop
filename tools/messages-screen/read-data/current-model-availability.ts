// PORTED FROM: bitfield-packages/packages/chat/read-data/current-model-availability.ts @ e99ac5976
// Pure owner-fact consumption. Every provider owner publishes the same model
// descriptor contract. Chat never branches on provider, runtime, locality, or
// machine path; a future provider appears by publishing DATA only.
export function currentAvailableModelRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const row = entry?.payload ?? entry;
    return row?.kind === 'ai-model-descriptor' && typeof row.id === 'string'
      && row.status === 'available' && typeof row.provider_ref === 'string'
      && typeof row.model_id === 'string' && row.model_id.trim().length > 0
      ? [row.id] : [];
  });
}

export function canRouteSelectedModel(model: string | null | undefined,
  configuredRefs: readonly string[], descriptors: unknown): boolean {
  if (!model) return false;
  return configuredRefs.includes(model) && currentAvailableModelRefs(descriptors).includes(model);
}
