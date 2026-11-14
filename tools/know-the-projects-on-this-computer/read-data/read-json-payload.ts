// packages/projects/read-data/read-json-payload.ts
//
// Shared JSON payload normalization for package-local decoders.

const textDecoder = new TextDecoder();

export function readJsonPayload(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return parseJsonText(textDecoder.decode(value));
  if (value instanceof ArrayBuffer) return parseJsonText(textDecoder.decode(value));
  if (typeof value === 'string') return parseJsonText(value);
  return value;
}

export function readStringPayload(value: unknown): string | null {
  const parsed = readJsonPayload(value);
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
}

export function readBooleanPayload(value: unknown): boolean {
  const parsed = readJsonPayload(value);
  return parsed === true || parsed === 'true';
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
