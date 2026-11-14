export interface IdeaProjectOption {
  value: string;
  label: string;
  path: string;
}

export interface IdeaCurrentProjectFeed {
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

export function decodeIdeaProjectRegistryFeed(raw: unknown): IdeaProjectOption[] {
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
    .filter((project): project is IdeaProjectOption => project !== null);
}

export function decodeIdeaCurrentProjectFeed(raw: unknown): IdeaCurrentProjectFeed {
  if (!Array.isArray(raw)) return { activeProject: null };
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const activeProject = asString((entry as Record<string, unknown>).activeProject);
    if (activeProject) return { activeProject };
  }
  return { activeProject: null };
}
