export type PublishedRecord = {
  payload?: unknown;
};

export type InstructionBlock = {
  body?: string;
  description?: string;
  id: string;
  label?: string;
  revision_ref?: string;
  status?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function readInstructionBlocks(records: readonly PublishedRecord[]): InstructionBlock[] {
  return records
    .map((record) => record.payload)
    .filter(isRecord)
    .filter((record) => record.kind === 'ai-instruction-block')
    .flatMap((record) => {
      const id = text(record.id);
      if (!id) return [];
      const body = text(record.body);
      const description = text(record.description);
      const label = text(record.label);
      const revisionRef = text(record.revision_ref);
      const status = text(record.status);
      return [{
        ...(body ? { body } : {}),
        ...(description ? { description } : {}),
        id,
        ...(label ? { label } : {}),
        ...(revisionRef ? { revision_ref: revisionRef } : {}),
        ...(status ? { status } : {}),
      }];
    })
    .sort((left, right) => String(left.label ?? left.id).localeCompare(String(right.label ?? right.id)));
}
