const textDecoder = new TextDecoder();

export function parseTaskJsonValue(raw: unknown): unknown {
  if (raw instanceof Uint8Array) {
    return parseTaskJsonValue(textDecoder.decode(raw));
  }
  if (raw instanceof ArrayBuffer) {
    return parseTaskJsonValue(new Uint8Array(raw));
  }
  if (ArrayBuffer.isView(raw)) {
    return parseTaskJsonValue(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  }
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function readTaskRecordArray(raw: unknown): Record<string, unknown>[] {
  const parsed = parseTaskJsonValue(raw);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

export function readTaskString(value: unknown): string {
  const parsed = parseTaskJsonValue(value);
  if (parsed == null) return '';
  return typeof parsed === 'string' ? parsed : String(parsed);
}
