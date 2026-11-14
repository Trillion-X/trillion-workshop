// packages/ui/show/path-rail/decode-path-nodes.ts
// Generic decoder: raw node rows + a DATA status-overrides map -> resolved
// PathNodeView[]. Status is an open string key resolved via DATA; no closed enum,
// no domain vocabulary (L090/L063).

import type { PathNodeView } from './PathNode';

export interface RawPathNode {
  id: string;
  label: string;
  status?: string;
  iconName?: string;
  bubble?: string;
  action?: Record<string, unknown>;
}

export interface PathStatusOverride {
  toneColor: string;
  ring?: boolean;
  dimmed?: boolean;
  complete?: boolean;
  bubble?: string;
}

export type PathStatusOverrides = Record<string, PathStatusOverride>;

export type PathIconResolver = (iconName?: string) => PathNodeView['icon'];

export interface DecodePathNodesOptions {
  statusOverrides: PathStatusOverrides;
  iconResolver?: PathIconResolver;
  defaultTone?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readAction(value: unknown): Record<string, unknown> | undefined {
  const obj = asObject(value);
  // Opaque passthrough: an action is any object with at least one of the open
  // fields consumers gate on by presence (target/payload/surface/...).
  return Object.keys(obj).length > 0 ? obj : undefined;
}

function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const wrapped = asObject(raw).nodes;
  return Array.isArray(wrapped) ? wrapped : [];
}

const DEFAULT_TONE = 'var(--text-muted)';

export function decodePathNodes(raw: unknown, options: DecodePathNodesOptions): PathNodeView[] {
  const overrides = options.statusOverrides ?? {};
  const fallbackTone = options.defaultTone ?? DEFAULT_TONE;
  const resolveIcon = options.iconResolver;

  const out: PathNodeView[] = [];
  for (const row of rowsOf(raw)) {
    const record = asObject((row as Record<string, unknown>)?.payload ?? row);
    const id = readString(record.id);
    if (!id) continue;

    const label = readString(record.label) || id;
    const status = readString(record.status);
    const override = overrides[status];
    const iconName = readString(record.iconName) || undefined;
    const ownBubble = readString(record.bubble) || undefined;
    const bubble = ownBubble ?? override?.bubble;
    const action = readAction(record.action);

    out.push({
      id,
      label,
      toneColor: override?.toneColor ?? fallbackTone,
      ...(override?.ring ? { ring: true } : {}),
      ...(override?.dimmed ? { dimmed: true } : {}),
      ...(override?.complete ? { complete: true } : {}),
      ...(bubble ? { bubble } : {}),
      ...(action ? { action } : {}),
      ...(resolveIcon ? { icon: resolveIcon(iconName) } : {}),
    });
  }
  return out;
}
