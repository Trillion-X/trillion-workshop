export interface GitCurrentProjectFeed {
  activeProject: string | null;
}

const textDecoder = new TextDecoder();

function readJsonPayload(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return readJsonPayload(textDecoder.decode(value as ArrayBufferView));
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function asProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function decodeGitCurrentProjectFeed(raw: unknown): GitCurrentProjectFeed {
  const payload = readJsonPayload(raw);
  if (!Array.isArray(payload)) return { activeProject: null };

  for (const entry of payload) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const activeProject = asProjectId((entry as Record<string, unknown>).activeProject);
    if (activeProject) return { activeProject };
  }
  return { activeProject: null };
}
