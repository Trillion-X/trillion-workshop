// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-projects.ts @ e99ac5976
export interface ChatProjectOption {
  value: string;
  label: string;
  path: string;
}

export interface ChatCurrentProjectFeed {
  activeProject: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function projectIdFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

function projectLabelFromId(projectId: string): string {
  return projectId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || projectId;
}

export function decodeChatProjectRegistryFeed(raw: unknown): ChatProjectOption[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const row = entry as Record<string, unknown>;
      const path = asString(row.path);
      const value = asString(row.id ?? row.projectId ?? row.project_id);
      if (!path || !value) return null;
      return {
        value,
        label: asString(row.name) ?? projectLabelFromId(projectIdFromPath(path)),
        path,
      };
    })
    .filter((project): project is ChatProjectOption => project !== null);
}

export function decodeChatCurrentProjectFeed(raw: unknown): ChatCurrentProjectFeed {
  if (!Array.isArray(raw)) return { activeProject: null };
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const activeProject = asString(row.activeProject);
    if (activeProject) return { activeProject };
  }
  return { activeProject: null };
}
