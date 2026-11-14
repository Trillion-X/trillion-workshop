export interface WorkspaceMember {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  joinedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function decodeWorkspaceMember(raw: unknown): WorkspaceMember | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id);
  if (!id) return null;
  return {
    id,
    email: text(raw.email),
    name: text(raw.name, text(raw.email, id)),
    role: text(raw.role, 'member'),
    status: text(raw.status, 'active'),
    joinedAt: text(raw.joinedAt ?? raw.joined_at, new Date(0).toISOString()),
  };
}

export function decodeWorkspaceMembersFeed(raw: unknown): WorkspaceMember[] {
  return Array.isArray(raw)
    ? raw.map(decodeWorkspaceMember).filter((member): member is WorkspaceMember => member !== null)
    : [];
}
