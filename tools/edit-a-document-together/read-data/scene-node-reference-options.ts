export interface SceneNodeOptionSource {
  source_type: 'scene_nodes';
  node_scope: 'root_children';
  kind: string;
  group?: string;
  icon?: string;
  label_path?: string;
  value_path?: string;
  limit?: number;
  backlinks_title?: string;
  missing_reference_label?: string;
}

export interface SceneNodeOption {
  value: string;
  label: string;
  kind: string;
  group: string;
  icon?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  return path.split('.').reduce<unknown>((current, key) =>
    record(current) && key !== '__proto__' && key !== 'prototype' && key !== 'constructor' ? current[key] : undefined, value);
}

/** Return the one DATA-declared same-scene page reference source, if unambiguous. */
export function sceneNodeReferenceSource(sources: readonly unknown[]): SceneNodeOptionSource | null {
  const matches = sources.filter((source): source is SceneNodeOptionSource => record(source)
    && source.source_type === 'scene_nodes' && source.node_scope === 'root_children'
    && typeof source.kind === 'string' && Boolean(source.kind.trim()))
    .map(source => ({
      source_type: 'scene_nodes' as const,
      node_scope: 'root_children' as const,
      kind: source.kind.trim(),
      ...(typeof source.group === 'string' && source.group.trim() ? { group: source.group.trim() } : {}),
      ...(typeof source.icon === 'string' && source.icon.trim() ? { icon: source.icon.trim() } : {}),
      ...(typeof source.label_path === 'string' && source.label_path.trim() ? { label_path: source.label_path.trim() } : {}),
      ...(typeof source.value_path === 'string' && source.value_path.trim() ? { value_path: source.value_path.trim() } : {}),
      ...(typeof source.limit === 'number' && Number.isFinite(source.limit) && source.limit > 0 ? { limit: source.limit } : {}),
      ...(typeof source.backlinks_title === 'string' && source.backlinks_title.trim() ? { backlinks_title: source.backlinks_title.trim() } : {}),
      ...(typeof source.missing_reference_label === 'string' && source.missing_reference_label.trim()
        ? { missing_reference_label: source.missing_reference_label.trim() } : {}),
    }));
  return matches.length === 1 ? matches[0] : null;
}

/** Project scene nodes using the same DATA paths, query and cap as published-record options. */
export function sceneNodeReferenceOptions(
  source: SceneNodeOptionSource,
  nodes: readonly { id: string; label: string }[],
  query: string,
): SceneNodeOption[] {
  const labelPath = source.label_path || 'label';
  const valuePath = source.value_path || 'id';
  const limit = Math.max(1, Math.min(1000, typeof source.limit === 'number' && source.limit > 0 ? Math.floor(source.limit) : 40));
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const result: SceneNodeOption[] = [];
  for (const node of nodes) {
    const value = pathValue(node, valuePath);
    const label = pathValue(node, labelPath);
    if (typeof value !== 'string' || !value.trim() || typeof label !== 'string' || !label.trim()
      || seen.has(value) || (needle && !label.toLowerCase().includes(needle))) continue;
    seen.add(value);
    result.push({
      value,
      label,
      kind: source.kind,
      group: source.group || source.kind,
      ...(source.icon ? { icon: source.icon } : {}),
    });
    if (result.length >= limit) break;
  }
  return result;
}
